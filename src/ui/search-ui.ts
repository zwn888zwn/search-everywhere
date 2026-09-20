import * as vscode from 'vscode';
import { SearchItem, SearchItemType } from '../core/types';
import { SearchService } from '../core/search-service';
import { parseSearchQuery } from '../core/search-query';
import { getConfiguration } from '../utils/config';

// Original vector badges inspired by JetBrains' symbol colors. Paths keep the
// small glyphs independent of installed fonts and the active product icon theme.
const SYMBOL_ICON_STYLES: Record<string, { fill: string; stroke: string; glyph: string; square?: boolean }> = {
    'symbol-class': { fill: '#DAE8FF', stroke: '#376AC3', glyph: 'M10.5 5.5C9 3.5 5 4.5 5 8s4 4.5 5.5 2.5' },
    'symbol-struct': { fill: '#DAE8FF', stroke: '#376AC3', glyph: 'M10.5 5H7a1.5 1.5 0 0 0 0 3h2a1.5 1.5 0 0 1 0 3H5.5' },
    'symbol-interface': { fill: '#DBF0DE', stroke: '#337747', glyph: 'M6 5h4M8 5v6M6 11h4' },
    'symbol-enum': { fill: '#DBF0DE', stroke: '#337747', glyph: 'M10 5H6v6h4M6 8h3' },
    'symbol-type-parameter': { fill: '#DAE8FF', stroke: '#376AC3', glyph: 'M5 5h6M8 5v6' },
    'symbol-function': { fill: '#ECDDFA', stroke: '#8150AB', glyph: 'M10 4.5H8.5A1.5 1.5 0 0 0 7 6v5.5M5.5 7h4' },
    'symbol-method': { fill: '#ECDDFA', stroke: '#8150AB', glyph: 'M4.5 10.5V6.5h2v4M6.5 7.5q2-2 2.5 0v3M9 7.5q2-2 2.5 0v3' },
    'symbol-constructor': { fill: '#ECDDFA', stroke: '#8150AB', glyph: 'M5 8h6M8 5v6' },
    'symbol-field': { fill: '#ECDDFA', stroke: '#8150AB', glyph: 'M10 4.5H8.5A1.5 1.5 0 0 0 7 6v5.5M5.5 7h4', square: true },
    'symbol-property': { fill: '#ECDDFA', stroke: '#8150AB', glyph: 'M6 11.5V5h2.5a2 2 0 0 1 0 4H6', square: true },
    'symbol-variable': { fill: '#FBE8CE', stroke: '#975D20', glyph: 'M5 5.5l3 5 3-5', square: true },
    'symbol-constant': { fill: '#FBE8CE', stroke: '#975D20', glyph: 'M10 5.5H7a2.5 2.5 0 0 0 0 5h3M5.5 12h5', square: true },
    'symbol-enum-member': { fill: '#FBE8CE', stroke: '#975D20', glyph: 'M5.5 8H10V7a2.25 2.25 0 0 0-4.5 0v2A2.25 2.25 0 0 0 8 11h2', square: true },
    'symbol-module': { fill: '#FBE8CE', stroke: '#975D20', glyph: 'M4.5 4.5h2v2h-2zM9.5 4.5h2v2h-2zM4.5 9.5h2v2h-2zM9.5 9.5h2v2h-2z', square: true },
    'symbol-namespace': { fill: '#FBE8CE', stroke: '#975D20', glyph: 'M6 4.5H5v2L4 8l1 1.5v2h1M10 4.5h1v2L12 8l-1 1.5v2h-1', square: true },
    'symbol-package': { fill: '#FBE8CE', stroke: '#975D20', glyph: 'M4.5 6L8 4l3.5 2v4L8 12l-3.5-2zM4.5 6L8 8l3.5-2M8 8v4', square: true },
    'symbol-misc': { fill: '#E4E7ED', stroke: '#596579', glyph: 'M8 4.5L11.5 8 8 11.5 4.5 8z' }
};

/**
 * Filter categories for search results
 */
export enum FilterCategory {
    All = 'all',
    Classes = 'classes',
    Files = 'files',
    Symbols = 'symbols',
    Actions = 'actions',
    Text = 'text'
}

/**
 * Manages the VSCode UI for search everywhere
 */
export class SearchUI {
    private static readonly LAST_QUERY_KEY = 'searchEverywhere.lastQuery';
    private quickPick: vscode.QuickPick<SearchQuickPickItem>;
    private searchDebounce: NodeJS.Timeout | undefined;
    private lastQuery: string = '';
    private config = getConfiguration();
    private previewDisposables: vscode.Disposable[] = [];
    private searchGeneration = 0;
    private isVisible = false;
    private readonly symbolIcons = new Map<string, vscode.Uri>();

    // Active filter category
    private activeFilter: FilterCategory = FilterCategory.All;

    // Custom buttons for filter categories
    private filterButtons: Map<FilterCategory, vscode.QuickInputButton> = new Map();

    // Prefixes for button tooltips
    private readonly ACTIVE_PREFIX = '● '; // Filled circle for active filter
    private readonly INACTIVE_PREFIX = '○ '; // Empty circle for inactive filter

    /**
     * Initialize the search UI
     */
    constructor(private searchService: SearchService, private context: vscode.ExtensionContext) {
        // Create quick pick UI
        this.quickPick = vscode.window.createQuickPick<SearchQuickPickItem>();
        this.quickPick.placeholder = 'Type to search everywhere (files, classes, symbols...)';
        this.quickPick.matchOnDescription = true;
        this.quickPick.matchOnDetail = true;
        this.quickPick.keepScrollPosition = false;
        (this.quickPick as vscode.QuickPick<SearchQuickPickItem> & { sortByLabel: boolean }).sortByLabel = false;
        this.quickPick.ignoreFocusOut = false;

        // Create filter category buttons
        this.createFilterButtons();

        // Set initial buttons
        this.updateFilterButtons();

        // Set up event handlers
        this.quickPick.onDidChangeValue(this.onDidChangeValue.bind(this));
        this.quickPick.onDidAccept(this.onDidAccept.bind(this));
        this.quickPick.onDidHide(this.onDidHide.bind(this));
        this.quickPick.onDidTriggerButton(this.onDidTriggerButton.bind(this));

        // Add preview handler
        this.quickPick.onDidChangeActive(this.onDidChangeActive.bind(this));

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('searchEverywhere.preview')) {
                this.config = getConfiguration();
            }
        });
    }

    /**
     * Create filter buttons for each category
     */
    private createFilterButtons(): void {
        // Define icons for each category
        this.filterButtons.set(FilterCategory.All, {
            iconPath: new vscode.ThemeIcon('search'),
            tooltip: this.INACTIVE_PREFIX + 'All'
        });

        this.filterButtons.set(FilterCategory.Classes, {
            iconPath: new vscode.ThemeIcon('symbol-class'),
            tooltip: this.INACTIVE_PREFIX + 'Classes'
        });

        this.filterButtons.set(FilterCategory.Files, {
            iconPath: new vscode.ThemeIcon('file'),
            tooltip: this.INACTIVE_PREFIX + 'Files'
        });

        this.filterButtons.set(FilterCategory.Symbols, {
            iconPath: new vscode.ThemeIcon('symbol-method'),
            tooltip: this.INACTIVE_PREFIX + 'Symbols'
        });

        this.filterButtons.set(FilterCategory.Actions, {
            iconPath: new vscode.ThemeIcon('run'),
            tooltip: this.INACTIVE_PREFIX + 'Actions'
        });

        this.filterButtons.set(FilterCategory.Text, {
            iconPath: new vscode.ThemeIcon('file-text'),
            tooltip: this.INACTIVE_PREFIX + 'Text'
        });
    }

    /**
     * Update the filter buttons in the UI based on the active filter
     */
    private updateFilterButtons(): void {
        // Create all filter buttons with updated states
        const buttons: vscode.QuickInputButton[] = [];
        const filterNames: string[] = []; // Collect names for the placeholder text

        // Add buttons in the desired order
        const orderedFilters = [
            FilterCategory.All,
            FilterCategory.Classes,
            FilterCategory.Files,
            FilterCategory.Symbols,
            FilterCategory.Actions,
            FilterCategory.Text
        ];

        for (const filter of orderedFilters) {
            // Get the base filter button
            const baseButton = this.filterButtons.get(filter);

            if (!baseButton) {continue;}

            const isActive = filter === this.activeFilter;
            const filterName = filter.charAt(0).toUpperCase() + filter.slice(1);

            // Track filter name (with highlighting if active)
            filterNames.push(isActive ? `[${filterName}]` : filterName);

            // Get base name without the prefix
            const baseName = (baseButton.tooltip || '').replace(this.ACTIVE_PREFIX, '').replace(this.INACTIVE_PREFIX, '');

            // Create a modified button with visual indicator for the active filter
            const button: vscode.QuickInputButton = {
                // Use dramatically different icons for active vs inactive filters
                iconPath: isActive
                    ? this.getActiveIcon(filter)
                    : baseButton.iconPath,
                // Add visual distinguisher to the tooltip text
                tooltip: isActive
                    ? this.ACTIVE_PREFIX + baseName
                    : this.INACTIVE_PREFIX + baseName
            };

            buttons.push(button);
        }

        // Update the QuickPick interface
        this.quickPick.buttons = buttons;

        // Update placeholder text with filter information
        if (this.activeFilter !== FilterCategory.All) {
            const activeFilterName = this.activeFilter.charAt(0).toUpperCase() + this.activeFilter.slice(1);

            this.quickPick.placeholder = `${activeFilterName} only`;
        } else {
            this.quickPick.placeholder = 'Search files, types, symbols, actions, and text';
        }
    }

    /**
     * Get a visually distinct active icon
     */
    private getActiveIcon(filter: FilterCategory): vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri } {
        // Use strongly contrasting icons for active state
        switch (filter) {
            case FilterCategory.All:
                return new vscode.ThemeIcon('search', new vscode.ThemeColor('focusBorder'));

            case FilterCategory.Classes:
                return new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor('focusBorder'));

            case FilterCategory.Files:
                return new vscode.ThemeIcon('files', new vscode.ThemeColor('focusBorder')); // Plural 'files' icon is different

            case FilterCategory.Symbols:
                return new vscode.ThemeIcon('symbol-field', new vscode.ThemeColor('focusBorder')); // Different symbol icon

            case FilterCategory.Actions:
                return new vscode.ThemeIcon('play', new vscode.ThemeColor('focusBorder')); // Use 'play' instead of 'run'

            case FilterCategory.Text:
                return new vscode.ThemeIcon('edit', new vscode.ThemeColor('focusBorder')); // Use 'edit' for text search

            default:
                return new vscode.ThemeIcon('search', new vscode.ThemeColor('focusBorder'));
        }
    }

    /**
     * Handle button clicks for category filters
     */
    private onDidTriggerButton(button: vscode.QuickInputButton): void {
        // Extract the base tooltip without prefixes
        const tooltip = button.tooltip || '';
        const baseTooltip = tooltip
            .replace(this.ACTIVE_PREFIX, '')
            .replace(this.INACTIVE_PREFIX, '');

        // Find which filter button was clicked
        for (const [category, filterButton] of this.filterButtons.entries()) {
            const buttonBaseTooltip = (filterButton.tooltip || '')
                .replace(this.ACTIVE_PREFIX, '')
                .replace(this.INACTIVE_PREFIX, '');

            if (buttonBaseTooltip === baseTooltip) {
                // Set the active filter
                this.activeFilter = category;

                // Clear search debounce
                if (this.searchDebounce) {
                    clearTimeout(this.searchDebounce);
                }

                this.searchService.cancelPendingSearches();

                // Update title to show active filter
                this.updateTitle();

                // Update buttons to highlight the active one
                this.updateFilterButtons();

                // Perform search with current query
                this.performSearch(this.lastQuery);
                break;
            }
        }
    }

    /**
     * Update the title of the quick pick to reflect the active filter
     */
    private updateTitle(): void {
        const filterName = this.activeFilter.charAt(0).toUpperCase() + this.activeFilter.slice(1);

        if (this.activeFilter === FilterCategory.All) {
            this.quickPick.title = 'Search Everywhere';
        } else {
            this.quickPick.title = `Search Everywhere - ${filterName}`;
        }
    }

    /**
     * Show the search dialog
     */
    public show(): void {
        if (this.searchDebounce) {
            clearTimeout(this.searchDebounce);
            this.searchDebounce = undefined;
        }

        this.searchService.cancelPendingSearches();
        this.searchGeneration++;
        this.isVisible = true;

        // Always reset to "All" filter when opening
        this.activeFilter = FilterCategory.All;

        const initialQuery = this.context.workspaceState.get<string>(SearchUI.LAST_QUERY_KEY, '');

        this.lastQuery = initialQuery;
        this.quickPick.busy = false;
        this.quickPick.keepScrollPosition = false;
        this.quickPick.activeItems = [];
        this.quickPick.selectedItems = [];
        this.quickPick.items = [];
        this.quickPick.value = initialQuery;

        // Refresh configuration
        this.config = getConfiguration();

        // Update buttons to reflect the active filter
        this.updateFilterButtons();

        // Update title
        this.updateTitle();

        // Show the quick pick
        this.quickPick.show();

        setTimeout(() => {
            if (!this.isVisible) {
                return;
            }

            this.searchService.startIndexing();
            this.performSearch(initialQuery);
        }, 0);
    }

    /**
     * Handle user typing in the search box
     */
    private onDidChangeValue(value: string): void {
        // Clear any scheduled search
        if (this.searchDebounce) {
            clearTimeout(this.searchDebounce);
        }

        // Don't search again if the query hasn't changed
        if (value === this.lastQuery) {
            return;
        }

        this.lastQuery = value;
        this.saveLastQuery(value);
        this.searchService.cancelPendingSearches();

        // Clear the previous virtualized rows before the next contributor batch
        // arrives. Replacing mixed result shapes in place can leave stale rows
        // painted by VS Code when a query is quickly deleted or replaced.
        this.quickPick.items = [];

        // Show "Searching..." when query changes
        this.quickPick.busy = true;

        // Debounce to avoid excessive searches while typing
        this.searchDebounce = setTimeout(() => {
            this.performSearch(value);
        }, 150);
    }

    /**
     * Execute search and update UI
     */
    private async performSearch(query: string): Promise<void> {
        const generation = ++this.searchGeneration;
        const searchFilter = this.activeFilter;

        try {
            this.quickPick.busy = true;

            if (!query.trim()) {
                const defaultItems = await this.searchService.getDefaultItems();

                if (this.isCurrentSearch(query, generation, searchFilter)) {
                    this.updateSearchItems(defaultItems);
                }

                return;
            }

            if (searchFilter === FilterCategory.All) {
                const indexedPromise = this.searchService.searchIndexed(query);
                let slowContributorsSettled = false;
                const slowContributorsPromise = Promise.all([
                    this.searchService.searchSymbols(query),
                    this.searchService.searchText(query)
                ]).then(results => {
                    slowContributorsSettled = true;

                    return results;
                });
                const indexedResults = await indexedPromise;

                if (!this.isCurrentSearch(query, generation, searchFilter)) {
                    return;
                }

                // Files, directories and actions come from the persisted index
                // and should feel instant. Skip this intermediate render when
                // cached slow contributors have already completed.
                if (indexedResults.length > 0 && !slowContributorsSettled) {
                    this.updateSearchItems(indexedResults);
                }

                const slowResults = await slowContributorsPromise;

                if (!this.isCurrentSearch(query, generation, searchFilter)) {
                    return;
                }

                this.updateSearchItems(this.searchService.mergeResults(query, [indexedResults, ...slowResults]));

                return;
            }

            const contributors = this.getContributorSearches(query, searchFilter);
            const resultSets = await Promise.all(contributors);

            if (!this.isCurrentSearch(query, generation, searchFilter)) {
                return;
            }

            this.updateSearchItems(this.searchService.mergeResults(query, resultSets));

        } catch (error) {
            console.error('Error performing search:', error);
            this.quickPick.placeholder = 'Error performing search';
        } finally {
            if (this.isCurrentSearch(query, generation, searchFilter)) {
                this.quickPick.busy = false;
            }
        }
    }

    private getContributorSearches(query: string, filter: FilterCategory): Array<Promise<SearchItem[]>> {
        switch (filter) {
            case FilterCategory.Classes:
                return [this.searchService.searchSymbols(query, [SearchItemType.Class])];

            case FilterCategory.Files:
                return [this.searchService.searchIndexed(query, [SearchItemType.File])];

            case FilterCategory.Symbols:
                return [this.searchService.searchSymbols(query, [SearchItemType.Symbol])];

            case FilterCategory.Actions:
                return [this.searchService.searchIndexed(query, [SearchItemType.Command])];

            case FilterCategory.Text:
                return [this.searchService.searchText(query)];

            case FilterCategory.All:

            default:
                return [
                    this.searchService.searchIndexed(query),
                    this.searchService.searchSymbols(query),
                    this.searchService.searchText(query)
                ];
        }
    }

    private isCurrentSearch(query: string, generation: number, filter: FilterCategory): boolean {
        return this.isVisible &&
            generation === this.searchGeneration &&
            query === this.lastQuery &&
            this.activeFilter === filter;
    }

    private updateSearchItems(results: SearchItem[]): void {
        const filteredResults = this.applyCategoryFilter(results);
        const items = filteredResults.map(item => this.createQuickPickItem(item));

        this.quickPick.keepScrollPosition = false;
        this.quickPick.activeItems = [];
        this.quickPick.selectedItems = [];
        this.quickPick.items = items;
    }

    private saveLastQuery(value: string): void {
        const trimmedValue = value.trim();

        if (!trimmedValue) {
            return;
        }

        void this.context.workspaceState.update(SearchUI.LAST_QUERY_KEY, trimmedValue);
    }

    /**
     * Apply the active category filter to search results
     */
    private applyCategoryFilter(items: SearchItem[]): SearchItem[] {
        // If "All" is selected, return all items
        if (this.activeFilter === FilterCategory.All) {
            return items;
        }

        // Otherwise, filter based on the selected category
        return items.filter(item => {
            switch (this.activeFilter) {
                case FilterCategory.Classes:
                    return item.type === SearchItemType.Class;

                case FilterCategory.Files:
                    return item.type === SearchItemType.File;

                case FilterCategory.Symbols:
                    return item.type === SearchItemType.Symbol;

                case FilterCategory.Actions:
                    return item.type === SearchItemType.Command;

                case FilterCategory.Text:
                    return item.type === SearchItemType.TextMatch;

                default:
                    return true;
            }
        });
    }

    /**
     * Handle user selecting an item
     */
    private async onDidAccept(): Promise<void> {
        const selectedItems = this.quickPick.selectedItems;

        if (selectedItems.length > 0) {
            const selectedItem = selectedItems[0];

            // Close the quick pick
            this.quickPick.hide();

            // Execute the action
            try {
                if (selectedItem.originalItem) {
                    await selectedItem.originalItem.action();
                }
            } catch (error) {
                console.error('Error executing action:', error);
                vscode.window.showErrorMessage(`Error executing action: ${error}`);
            }
        }
    }

    /**
     * Handle user closing the dialog
     */
    private onDidHide(): void {
        this.isVisible = false;
        this.searchGeneration++;

        // Clear any scheduled search
        if (this.searchDebounce) {
            clearTimeout(this.searchDebounce);
            this.searchDebounce = undefined;
        }

        this.searchService.cancelPendingSearches();

        // Clear quick pick items to free memory
        this.quickPick.busy = false;
        this.quickPick.activeItems = [];
        this.quickPick.selectedItems = [];
        this.quickPick.items = [];

        // Dispose of any preview disposables
        this.disposePreviewDisposables();

        // Refresh the persisted index after the interactive search is gone, so
        // large workspaces do not compete with the current typing/search path.
        this.searchService.scheduleBackgroundRefresh(1500);
    }

    /**
     * Dispose of preview-related disposables
     */
    private disposePreviewDisposables(): void {
        for (const disposable of this.previewDisposables) {
            disposable.dispose();
        }
        this.previewDisposables = [];
    }

    /**
     * Handle selection changes for previewing
     */
    private onDidChangeActive(items: readonly SearchQuickPickItem[]): void {
        // Skip if preview is disabled or no items are selected
        if (!this.config.preview.enabled || items.length === 0) {
            return;
        }

        // Get the selected item
        const selectedItem = items[0];

        // Skip separators and items without an original item
        if (selectedItem.kind === vscode.QuickPickItemKind.Separator || !selectedItem.originalItem) {
            return;
        }

        // Clear previous preview disposables
        this.disposePreviewDisposables();

        // Handle different types of items
        const item = selectedItem.originalItem;

        // Only preview items that have a URI and can be opened in the editor
        if ('uri' in item && item.uri instanceof vscode.Uri) {
            this.previewItem(item as SearchItem & { uri: vscode.Uri });
        }
    }

    /**
     * Preview a search item in the editor
     */
    private async previewItem(item: SearchItem & { uri: vscode.Uri }): Promise<void> {
        try {
            // Open the document
            const document = await vscode.workspace.openTextDocument(item.uri);

            // Define preview options
            const options: vscode.TextDocumentShowOptions = {
                preserveFocus: true, // Keep focus on the search dialog
                preview: true        // Show in preview tab
            };

            // Add range if available (for symbols)
            if ('range' in item && item.range instanceof vscode.Range) {
                options.selection = item.range;
            }

            // Show the document
            const editor = await vscode.window.showTextDocument(document, options);

            // Highlight the range if available
            if ('range' in item && item.range instanceof vscode.Range) {
                // Create decoration type for highlighting
                const decorationType = vscode.window.createTextEditorDecorationType({
                    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
                    borderColor: new vscode.ThemeColor('editor.findMatchHighlightBorder')
                });

                // Apply decoration
                editor.setDecorations(decorationType, [item.range]);

                // Add to disposables to clean up when selection changes
                this.previewDisposables.push(decorationType);
            }
        } catch (error) {
            console.error('Error previewing item:', error);
        }
    }

    /**
     * Convert a SearchItem to a QuickPickItem
     */
    private createQuickPickItem(item: SearchItem): SearchQuickPickItem {
        const label = this.formatLabel(item);
        let description = this.toQuickPickText(item.description);

        if ('uri' in item && item.uri instanceof vscode.Uri) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(item.uri);

            if (workspaceFolder) {
                // Get the relative path from the workspace root
                description = vscode.workspace.asRelativePath(item.uri);

                if ('range' in item && item.range instanceof vscode.Range) {
                    const lineNumber = item.range.start.line + 1;

                    description = `${description}:${lineNumber}`;
                }
            }
        }

        return {
            label: label,
            description: description,
            alwaysShow: true,
            iconPath: this.getResultIcon(item),
            originalItem: item,
            type: item.type
        };
    }

    private getResultIcon(item: SearchItem): vscode.ThemeIcon | vscode.Uri | undefined {
        if ((item.type === SearchItemType.Symbol || item.type === SearchItemType.Class) && 'symbolKind' in item) {
            const iconId = this.getSymbolIconId(item.symbolKind as vscode.SymbolKind);
            const cached = this.symbolIcons.get(iconId);

            if (cached) {
                return cached;
            }

            const { fill, stroke, glyph, square } = SYMBOL_ICON_STYLES[iconId];
            const shape = square
                ? '<rect x="1.5" y="1.5" width="13" height="13" rx="3"/>'
                : '<circle cx="8" cy="8" r="6.5"/>';
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><g fill="${fill}" stroke="${stroke}">${shape}</g><path d="${glyph}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
            const icon = vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);

            this.symbolIcons.set(iconId, icon);

            return icon;
        }

        return item.iconPath instanceof vscode.ThemeIcon ? item.iconPath : undefined;
    }

    private getSymbolIconId(kind: vscode.SymbolKind): string {
        switch (kind) {
            case vscode.SymbolKind.Module:
                return 'symbol-module';

            case vscode.SymbolKind.Namespace:
                return 'symbol-namespace';

            case vscode.SymbolKind.Package:
                return 'symbol-package';

            case vscode.SymbolKind.EnumMember:
                return 'symbol-enum-member';

            case vscode.SymbolKind.TypeParameter:
                return 'symbol-type-parameter';

            case vscode.SymbolKind.Class:
                return 'symbol-class';

            case vscode.SymbolKind.Interface:
                return 'symbol-interface';

            case vscode.SymbolKind.Struct:
                return 'symbol-struct';

            case vscode.SymbolKind.Enum:
                return 'symbol-enum';

            case vscode.SymbolKind.Method:
                return 'symbol-method';

            case vscode.SymbolKind.Function:
                return 'symbol-function';

            case vscode.SymbolKind.Constructor:
                return 'symbol-constructor';

            case vscode.SymbolKind.Constant:
                return 'symbol-constant';

            case vscode.SymbolKind.Field:
                return 'symbol-field';

            case vscode.SymbolKind.Property:
                return 'symbol-property';

            case vscode.SymbolKind.Variable:
                return 'symbol-variable';

            default:
                return 'symbol-misc';
        }
    }

    private formatLabel(item: SearchItem): string {
        if (item.type !== SearchItemType.TextMatch) {
            return this.toQuickPickText(item.label);
        }

        const textItem = item as SearchItem & { lineText?: string };
        const lineText = this.toQuickPickText(textItem.lineText || item.label).trim();
        const query = parseSearchQuery(this.lastQuery).term;

        if (!query) {
            return this.truncateMiddle(lineText, 120);
        }

        const matchIndex = lineText.toLowerCase().indexOf(query.toLowerCase());

        if (matchIndex === -1 || lineText.length <= 120) {
            return this.truncateMiddle(lineText, 120);
        }

        const contextBefore = 32;
        const contextAfter = 88;
        const start = Math.max(0, matchIndex - contextBefore);
        const end = Math.min(lineText.length, matchIndex + query.length + contextAfter);
        const prefix = start > 0 ? '...' : '';
        const suffix = end < lineText.length ? '...' : '';

        return `${prefix}${lineText.substring(start, end)}${suffix}`;
    }

    private toQuickPickText(value: unknown): string {
        if (typeof value === 'string') {
            return value;
        }

        if (typeof value === 'number' || typeof value === 'boolean') {
            return String(value);
        }

        if (value && typeof value === 'object') {
            const localizedValue = (value as { value?: unknown }).value;

            if (typeof localizedValue === 'string') {
                return localizedValue;
            }

            const label = (value as { label?: unknown }).label;

            if (typeof label === 'string') {
                return label;
            }
        }

        return '';
    }

    private truncateMiddle(text: string, maxLength: number): string {
        if (text.length <= maxLength) {
            return text;
        }

        const half = Math.floor((maxLength - 3) / 2);

        return `${text.substring(0, half)}...${text.substring(text.length - half)}`;
    }

}

/**
 * Extended QuickPickItem with search-specific properties
 */
interface SearchQuickPickItem extends vscode.QuickPickItem {
    originalItem?: SearchItem;
    type: SearchItemType;
}
