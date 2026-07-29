import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { CommandSearchItem, FileSearchItem, FuzzySearcher, SearchEverywhereConfig, SearchItem, SearchItemType, SearchProvider, SymbolKindGroup, SymbolSearchItem, TextMatchItem } from './types';
import { FileSearchProvider } from '../providers/file-provider';
import { CommandSearchProvider } from '../providers/command-provider';
import { SymbolSearchProvider } from '../providers/symbol-provider';
import { TextSearchProvider } from '../providers/text-provider';
import { parseSearchQuery, ParsedSearchQuery } from './search-query';
import { getConfiguration } from '../utils/config';
import { SearchFactory } from '../search/search-factory';
import { getIdeaNameMatchScore } from '../search/fuzzysort-adapter';
import { Debouncer } from '../utils/debouncer';
import { isWorkspaceFile } from '../utils/workspace';
import { ExclusionPatterns } from '../utils/exclusions';

interface FileLocationQuery {
    pathQuery: string;
    line: number;
    column?: number;
}

interface SearchOptions {
    includeText?: boolean;
    includeSymbols?: boolean;
    types?: SearchItemType[];
}

/**
 * Main service for coordinating search functionality
 */
export class SearchService {
    private static readonly CACHE_VERSION = 10;
    private static readonly MAX_CACHE_LOAD_BYTES = 64 * 1024 * 1024;
    private static readonly MAX_QUERY_CACHE_ENTRIES = 30;

    private providers: Map<string, SearchProvider> = new Map();
    private searcher: FuzzySearcher;
    private config: SearchEverywhereConfig;
    private allItems: SearchItem[] = [];
    private recentlyModifiedFiles: Map<string, number> = new Map(); // Uri -> timestamp
    private activityDebouncer: Debouncer;
    private indexUpdateDebouncer: Debouncer;
    private cacheLoadPromise: Promise<void>;
    private indexStartupStarted = false;
    private indexRefreshPromise: Promise<void> | undefined;
    private backgroundRefreshTimer: NodeJS.Timeout | undefined;
    private backgroundRefreshRequestPromise: Promise<void> | undefined;
    private resolveBackgroundRefreshRequest: (() => void) | undefined;
    private backgroundRefreshRequested = false;
    private indexedResultCache = new Map<string, SearchItem[]>();
    private symbolResultCache = new Map<string, SearchItem[]>();
    private textResultCache = new Map<string, SearchItem[]>();

    /**
     * Initialize the search service
     */
    constructor(private context: vscode.ExtensionContext) {
        // Get initial configuration
        this.config = getConfiguration();

        // Create the searcher based on configuration
        this.searcher = SearchFactory.createSearcher(this.config.fuzzySearch.library);

        // Set up debouncers
        this.activityDebouncer = new Debouncer(500);
        this.indexUpdateDebouncer = new Debouncer(3500); // Wait a bit longer than provider refresh

        // Register search providers
        this.registerProviders();

        this.cacheLoadPromise = Promise.resolve();

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('searchEverywhere')) {
                this.invalidateQueryCaches();
                this.config = getConfiguration();

                // Update searcher if library changed
                if (e.affectsConfiguration('searchEverywhere.fuzzySearch.library')) {
                    this.searcher = SearchFactory.createSearcher(this.config.fuzzySearch.library);
                }

                // Refresh providers if indexing settings changed
                if (e.affectsConfiguration('searchEverywhere.indexing')) {
                    void this.refreshIndex(false, true);
                }
            }
        });

        // Track file activity
        this.trackFileActivity();

        // Watch for file changes to update indexes
        this.watchFileChanges();

        // Index loading is started lazily after the search UI is visible.
    }

    public startIndexing(): void {
        if (this.indexStartupStarted) {
            return;
        }

        this.indexStartupStarted = true;
        let resolveCacheLoad!: () => void;

        this.cacheLoadPromise = new Promise(resolve => {
            resolveCacheLoad = resolve;
        });

        void vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Loading Search Everywhere index...',
                cancellable: false
            },
            async (progress) => {
                try {
                    await this.loadIndexCache(progress);

                    if (this.allItems.length === 0) {
                        progress.report({ message: 'Building initial file index...', increment: 5 });
                        await this.loadInitialFileIndex();
                    }
                } finally {
                    resolveCacheLoad();
                }

                progress.report({ message: `Cache usable (${this.allItems.length} items). Waiting to refresh full index...`, increment: 0 });
                await this.waitForBackgroundRefreshRequest();
                progress.report({ message: 'Refreshing full workspace index...', increment: 0 });
                await this.refreshIndex(false, false, progress);
                progress.report({ message: `Full index ready (${this.allItems.length} items)`, increment: 100 });
            }
        ).then(undefined, error => {
            resolveCacheLoad();
            console.error('Error starting Search Everywhere index:', error);
        });

    }

    public scheduleBackgroundRefresh(delayMs: number = 1000): void {
        this.startIndexing();

        if (this.backgroundRefreshTimer) {
            clearTimeout(this.backgroundRefreshTimer);
        }

        this.backgroundRefreshTimer = setTimeout(() => {
            this.backgroundRefreshTimer = undefined;
            this.requestBackgroundRefresh();
        }, delayMs);
    }

    private waitForBackgroundRefreshRequest(): Promise<void> {
        if (this.backgroundRefreshRequested) {
            return Promise.resolve();
        }

        if (!this.backgroundRefreshRequestPromise) {
            this.backgroundRefreshRequestPromise = new Promise(resolve => {
                this.resolveBackgroundRefreshRequest = resolve;
            });
        }

        return this.backgroundRefreshRequestPromise;
    }

    private requestBackgroundRefresh(): void {
        if (this.backgroundRefreshRequested) {
            return;
        }

        this.backgroundRefreshRequested = true;
        this.resolveBackgroundRefreshRequest?.();
    }

    /**
     * Watch for file changes to update the indexes
     */
    private watchFileChanges(): void {
        // Watch for file saves - the providers will refresh internally, we need to collect their results
        vscode.workspace.onDidSaveTextDocument(() => {
            console.log('File saved, scheduling index update...');
            this.invalidateQueryCaches();
            this.invalidateTextIndex();
            this.scheduleIndexUpdate();
        });

        vscode.workspace.onDidCreateFiles(() => {
            this.invalidateQueryCaches();
            this.invalidateTextIndex();
            this.scheduleIndexUpdate();
        });

        vscode.workspace.onDidDeleteFiles(() => {
            this.invalidateQueryCaches();
            this.invalidateTextIndex();
            this.scheduleIndexUpdate();
        });

        vscode.workspace.onDidRenameFiles(() => {
            this.invalidateQueryCaches();
            this.invalidateTextIndex();
            this.scheduleIndexUpdate();
        });

        // Do not update on document close. Previewing search results can close
        // documents frequently, and treating that as an index mutation makes
        // results appear/disappear after the visible indexing progress ended.
    }

    /**
     * Schedule an index update, debounced to avoid too many updates
     */
    private scheduleIndexUpdate(): void {
        this.indexUpdateDebouncer.debounce(() => {
            console.log('Updating search index after file changes...');
            // Pull the latest items from all providers without forcing a full refresh
            void this.updateIndexFromProviders();
        });
    }

    /**
     * Update the index by getting the latest items from all providers
     * This is faster than a full refresh because it doesn't force providers to re-index
     */
    private async updateIndexFromProviders(): Promise<void> {
        // Keep already available results usable while slower providers refresh.
        const deduplicationMap = new Map<string, SearchItem>();

        for (const item of this.allItems) {
            deduplicationMap.set(this.getDeduplicationKey(item), item);
        }

        // Collect only providers that are cheap and deterministic after edits.
        // Symbols are found on demand; pulling them here can silently run
        // a workspace scan after the progress notification has already closed.
        const providerEntries = [...this.providers.entries()]
            .filter(([name]) => name === 'files' || name === 'commands');

        for (const [name, provider] of providerEntries) {
            try {
                const items = await provider.getItems();

                console.log(`Got ${items.length} items from ${name} provider after file change`);

                // Deduplicate items as they come in
                for (const item of items) {
                    if (!this.isWorkspaceScopedItem(item)) {
                        continue;
                    }

                    const dedupeKey = this.getDeduplicationKey(item);

                    if (!deduplicationMap.has(dedupeKey)) {
                        deduplicationMap.set(dedupeKey, item);
                    }
                }
            } catch (error) {
                console.error(`Error getting items from ${name} provider:`, error);
            }
        }

        // Update the allItems array with the latest items
        this.allItems = Array.from(deduplicationMap.values());
        this.indexedResultCache.clear();
        void this.saveIndexCache();
        void (this.providers.get('text') as TextSearchProvider | undefined)?.refresh();

        console.log(`Index update completed: ${this.allItems.length} items (after deduplication)`);
    }

    /**
     * Track user file activity to boost recently modified files in search results
     */
    private trackFileActivity(): void {
        // Track document saves
        vscode.workspace.onDidSaveTextDocument(document => {
            this.trackDocumentActivity(document.uri);
        });

        // Track active editor changes
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && editor.document) {
                this.trackDocumentActivity(editor.document.uri);
            }
        });
    }

    /**
     * Track document activity
     */
    private trackDocumentActivity(uri: vscode.Uri): void {
        if (!isWorkspaceFile(uri)) {
            return;
        }

        this.activityDebouncer.debounce(() => {
            // Record the timestamp when this file was accessed
            this.recentlyModifiedFiles.set(uri.toString(), Date.now());

            // Keep only the 20 most recent files
            if (this.recentlyModifiedFiles.size > 20) {
                // Get all entries sorted by timestamp (oldest first)
                const entries = [...this.recentlyModifiedFiles.entries()]
                    .sort((a, b) => a[1] - b[1]);

                // Remove the oldest entry
                this.recentlyModifiedFiles.delete(entries[0][0]);
            }
        });
    }

    /**
     * Keep file-backed search results limited to the current workspace.
     */
    private isWorkspaceScopedItem(item: SearchItem): boolean {
        if ('uri' in item && item.uri instanceof vscode.Uri) {
            return isWorkspaceFile(item.uri);
        }

        return true;
    }

    /**
     * Register all search providers
     */
    private registerProviders(): void {
        // Add file provider
        if (this.config.indexing.includeFiles) {
            this.providers.set('files', new FileSearchProvider());
        }

        // Symbols are contributed on demand by the active language servers.
        if (this.config.indexing.includeSymbols) {
            this.providers.set('symbols', new SymbolSearchProvider());
        }

        // Add command provider
        if (this.config.indexing.includeCommands) {
            this.providers.set('commands', new CommandSearchProvider());
        }

        // Add text search provider
        if (this.config.indexing.includeText) {
            this.providers.set('text', new TextSearchProvider(
                this.getStorageUri(),
                this.config.performance.maxTextFileSizeBytes,
                this.config.performance.maxTextIndexBytes
            ));
        }
    }

    /**
     * Refresh all search indexes
     * @param force If true, forces a complete reindex even if the provider is already refreshing
     */
    public async refreshIndex(
        force: boolean = false,
        recreateProviders: boolean = force,
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<void> {
        if (this.indexRefreshPromise && !force && !recreateProviders) {
            return this.indexRefreshPromise;
        }

        this.indexRefreshPromise = this.refreshIndexInternal(force, recreateProviders, progress);

        try {
            await this.indexRefreshPromise;
        } finally {
            this.indexRefreshPromise = undefined;
        }
    }

    private async refreshIndexInternal(
        force: boolean = false,
        recreateProviders: boolean = force,
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<void> {
        // Refresh providers based on configuration only when the provider set may have changed.
        if (recreateProviders) {
            this.invalidateQueryCaches();
            this.providers.clear();
            this.registerProviders();
        }

        // Keep cached/previous results usable while slower providers refresh in the background.
        const deduplicationMap = new Map<string, SearchItem>();

        if (!force && !recreateProviders) {
            for (const item of this.allItems) {
                deduplicationMap.set(this.getDeduplicationKey(item), item);
            }
        }

        // Collect items from all providers
        const providerEntries = [...this.providers.entries()]
            .filter(([name]) => name !== 'symbols');

        providerEntries.sort(([leftName], [rightName]) => this.getProviderRefreshOrder(leftName) - this.getProviderRefreshOrder(rightName));

        const providerIncrement = providerEntries.length > 0 ? Math.floor(55 / providerEntries.length) : 0;

        for (const [name, provider] of providerEntries) {
            try {
                progress?.report({ message: `Indexing ${name}...`, increment: providerIncrement });

                // If force is true, we'll manually call refresh on each provider
                if (force) {
                    console.log(`Forcing refresh of ${name} provider...`);
                    await provider.refresh();
                } else if (provider instanceof TextSearchProvider) {
                    void provider.refresh();
                }

                const items = await provider.getItems();

                console.log(`Got ${items.length} items from ${name} provider`);

                if (!force && !recreateProviders) {
                    for (const [key, item] of [...deduplicationMap.entries()]) {
                        if (this.getProviderNameForItem(item) === name) {
                            deduplicationMap.delete(key);
                        }
                    }
                }

                // Deduplicate items as they come in
                for (const item of items) {
                    if (!this.isWorkspaceScopedItem(item)) {
                        continue;
                    }

                    const dedupeKey = this.getDeduplicationKey(item);

                    if (!deduplicationMap.has(dedupeKey)) {
                        deduplicationMap.set(dedupeKey, item);
                    }
                }

            } catch (error) {
                console.error(`Error getting items from ${name} provider:`, error);
            }
        }

        // Convert the deduplication map to the array
        this.allItems = Array.from(deduplicationMap.values());
        this.indexedResultCache.clear();
        progress?.report({ message: `Writing index cache (${this.allItems.length} items)...`, increment: 10 });
        await this.saveIndexCache();

        console.log(`Indexing completed: ${this.allItems.length} items (after deduplication)`);
    }

    private getProviderRefreshOrder(name: string): number {
        switch (name) {
            case 'files':
                return 0;

            case 'commands':
                return 1;

            case 'text':
                return 2;

            case 'symbols':
                return 3;

            default:
                return 10;
        }
    }

    private getProviderNameForItem(item: SearchItem): string | undefined {
        switch (item.type) {
            case SearchItemType.File:
                return 'files';

            case SearchItemType.Symbol:

            case SearchItemType.Class:
                return 'symbols';

            case SearchItemType.Command:
                return 'commands';

            case SearchItemType.TextMatch:
                return 'text';

            default:
                return undefined;
        }
    }

    /**
     * Generate a key for deduplicating search items
     */
    private async loadInitialFileIndex(): Promise<void> {
        const fileProvider = this.providers.get('files');

        if (!(fileProvider instanceof FileSearchProvider)) {
            return;
        }

        try {
            const items = await fileProvider.warmUp(2000);
            const deduplicationMap = new Map<string, SearchItem>();

            for (const item of this.allItems) {
                deduplicationMap.set(this.getDeduplicationKey(item), item);
            }

            for (const item of items) {
                if (!this.isWorkspaceScopedItem(item)) {
                    continue;
                }

                deduplicationMap.set(this.getDeduplicationKey(item), item);
            }

            this.allItems = Array.from(deduplicationMap.values());
        } catch (error) {
            console.error('Error building initial file index:', error);
        }
    }

    private async loadIndexCache(progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
        progress?.report({ message: 'Reading cached file/action index...', increment: 10 });

        try {
            const cacheUri = this.getCacheUri('search-index.jsonl');
            const stat = await vscode.workspace.fs.stat(cacheUri);

            if (stat.size > SearchService.MAX_CACHE_LOAD_BYTES) {
                console.log(`Skipping oversized search index cache: ${stat.size} bytes`);
                progress?.report({ message: 'Skipping oversized cached index', increment: 80 });

                return;
            }

            progress?.report({ message: 'Streaming cached file/action index...', increment: 45 });
            await this.loadIndexCacheJsonl(cacheUri);

            console.log(`Loaded ${this.allItems.length} cached search items`);
            progress?.report({ message: `Loaded ${this.allItems.length} cached items`, increment: 35 });
        } catch (error) {
            console.log(`No search index cache loaded: ${error}`);
            progress?.report({ message: 'No cached file/action index found', increment: 80 });
        }

    }

    private async loadIndexCacheJsonl(cacheUri: vscode.Uri): Promise<void> {
        const items: SearchItem[] = [];
        let isHeader = true;
        let isSupportedVersion = false;
        const stream = fs.createReadStream(cacheUri.fsPath, { encoding: 'utf8' });
        const lines = readline.createInterface({
            input: stream,
            crlfDelay: Infinity
        });

        for await (const line of lines) {
            if (!line.trim()) {
                continue;
            }

            if (isHeader) {
                isHeader = false;
                const header = JSON.parse(line) as CachedSearchIndexHeader;

                isSupportedVersion = header.version === SearchService.CACHE_VERSION;

                if (!isSupportedVersion) {
                    lines.close();
                    stream.destroy();

                    break;
                }

                if (Array.isArray(header.recentFiles)) {
                    this.recentlyModifiedFiles = new Map(header.recentFiles);
                }

                continue;
            }

            if (!isSupportedVersion) {
                continue;
            }

            const cachedItem = JSON.parse(line) as CachedSearchItem;
            const item = this.deserializeCachedItem(cachedItem);

            // The cache is written from already-filtered provider results. Re-running
            // every exclusion glob for every cached file makes cache restore scale with
            // both the number of files and exclusion patterns. A full refresh applies
            // the current exclusion rules before rewriting this cache.
            if (item && this.isWorkspaceScopedItem(item)) {
                items.push(item);
            }
        }

        this.allItems = items;
    }

    private async saveIndexCache(): Promise<void> {
        try {
            const storageUri = this.getStorageUri();

            await vscode.workspace.fs.createDirectory(storageUri);
            await this.saveIndexCacheJsonl(this.getCacheUri('search-index.jsonl'));
        } catch (error) {
            console.error('Error saving search index cache:', error);
        }
    }

    private async saveIndexCacheJsonl(cacheUri: vscode.Uri): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const stream = fs.createWriteStream(cacheUri.fsPath, { encoding: 'utf8' });
            const header: CachedSearchIndexHeader = {
                version: SearchService.CACHE_VERSION,
                recentFiles: [...this.recentlyModifiedFiles.entries()]
            };

            stream.on('error', reject);
            stream.on('finish', resolve);
            stream.write(`${JSON.stringify(header)}\n`);

            for (const item of this.allItems) {
                const cachedItem = this.serializeItem(item);

                if (cachedItem) {
                    stream.write(`${JSON.stringify(cachedItem)}\n`);
                }
            }

            stream.end();
        });
    }

    private getStorageUri(): vscode.Uri {
        return this.context.storageUri || vscode.Uri.joinPath(this.context.globalStorageUri, 'workspace-cache');
    }

    private getCacheUri(fileName: string): vscode.Uri {
        return vscode.Uri.joinPath(this.getStorageUri(), fileName);
    }

    private serializeItem(item: SearchItem): CachedSearchItem | undefined {
        const baseItem = {
            id: item.id,
            label: item.label,
            description: item.description,
            detail: item.detail,
            type: item.type,
            priority: item.priority
        };

        if (item.type === SearchItemType.File && 'uri' in item && item.uri instanceof vscode.Uri) {
            const fileItem = item as FileSearchItem;

            return {
                ...baseItem,
                uri: item.uri.toString(),
                isDirectory: fileItem.isDirectory
            };
        }

        if (item.type === SearchItemType.Command && 'command' in item) {
            const commandItem = item as CommandSearchItem;

            return {
                ...baseItem,
                command: commandItem.command,
                args: commandItem.args
            };
        }

        return undefined;
    }

    private isExcludedItem(item: SearchItem): boolean {
        if ('uri' in item && item.uri instanceof vscode.Uri) {
            return ExclusionPatterns.shouldExclude(item.uri);
        }

        return false;
    }

    private deserializeCachedItem(item: CachedSearchItem): SearchItem | undefined {
        if (item.type === SearchItemType.File && item.uri) {
            const uri = vscode.Uri.parse(item.uri);
            const fileItem: FileSearchItem = {
                id: item.id,
                label: item.label,
                description: item.description,
                detail: item.detail,
                type: SearchItemType.File,
                uri,
                isDirectory: item.isDirectory,
                iconPath: new vscode.ThemeIcon(item.isDirectory ? 'folder' : 'file'),
                priority: item.priority,
                action: async () => {
                    if (item.isDirectory) {
                        await vscode.commands.executeCommand('revealInExplorer', uri);
                    } else {
                        await vscode.window.showTextDocument(uri);
                    }
                }
            };

            return fileItem;
        }

        if ((item.type === SearchItemType.Symbol || item.type === SearchItemType.Class) && item.uri && item.range && item.symbolKind !== undefined) {
            const uri = vscode.Uri.parse(item.uri);
            const range = deserializeRange(item.range);
            const symbolItem: SymbolSearchItem = {
                id: item.id,
                label: item.label,
                description: item.description,
                detail: item.detail,
                type: item.type,
                uri,
                range,
                symbolKind: item.symbolKind,
                symbolGroup: item.symbolGroup,
                priority: item.priority,
                iconPath: new vscode.ThemeIcon(item.type === SearchItemType.Class ? 'symbol-class' : 'symbol-method'),
                action: async () => {
                    const document = await vscode.workspace.openTextDocument(uri);
                    const editor = await vscode.window.showTextDocument(document);

                    editor.selection = new vscode.Selection(range.start, range.start);
                    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                }
            };

            return symbolItem;
        }

        if (item.type === SearchItemType.Command && item.command) {
            const commandItem: CommandSearchItem = {
                id: item.id,
                label: item.label,
                description: item.description,
                detail: item.detail,
                type: SearchItemType.Command,
                command: item.command,
                args: item.args,
                priority: item.priority,
                iconPath: new vscode.ThemeIcon('terminal-bash'),
                action: async () => {
                    await vscode.commands.executeCommand(item.command!, ...(item.args || []));
                }
            };

            return commandItem;
        }

        return undefined;
    }

    private getDeduplicationKey(item: SearchItem): string {
        // Normalize the label by removing parentheses from method names
        const normalizedLabel = item.label.replace(/\(\)$/, '');

        if (item.type === SearchItemType.Symbol && 'uri' in item && 'range' in item) {
            // For symbols, deduplicate based on name, uri, and position
            const symbolItem = item as { uri: vscode.Uri, range: vscode.Range };

            return `symbol:${normalizedLabel}:${symbolItem.uri.toString()}:${symbolItem.range.start.line}:${symbolItem.range.start.character}`;
        } else if (item.type === SearchItemType.Class && 'uri' in item && 'range' in item) {
            // For classes, deduplicate based on name, uri, and position
            const classItem = item as { uri: vscode.Uri, range: vscode.Range };

            return `class:${normalizedLabel}:${classItem.uri.toString()}:${classItem.range.start.line}:${classItem.range.start.character}`;
        } else if (item.type === SearchItemType.File && 'uri' in item) {
            // For files, deduplicate based on URI
            const fileItem = item as { uri: vscode.Uri };

            return `file:${fileItem.uri.toString()}`;
        } else if (item.type === SearchItemType.Command && 'command' in item) {
            // For commands, deduplicate based on command id
            const cmdItem = item as { command: string };

            return `command:${cmdItem.command}`;
        }

        // Fallback to the item ID with normalized label
        return `${item.type}:${normalizedLabel}:${item.id.split(':').slice(1).join(':')}`;
    }

    /**
     * Compatibility entry point for callers that want one completed result set.
     * The UI calls each contributor separately so fast contributors can appear
     * immediately while the slower text search is still running.
     */
    public async search(query: string, options: SearchOptions = {}): Promise<SearchItem[]> {
        const parsedQuery = parseSearchQuery(query);

        if (!parsedQuery.term) {
            return [];
        }

        const allowedTypes = options.types ? new Set(options.types) : undefined;
        const includeSymbols = options.includeSymbols !== false &&
            (!allowedTypes || allowedTypes.has(SearchItemType.Symbol) || allowedTypes.has(SearchItemType.Class));
        const includeText = options.includeText === true &&
            (!allowedTypes || allowedTypes.has(SearchItemType.TextMatch));
        const contributors: Array<Promise<SearchItem[]>> = [this.searchIndexed(query, options.types)];

        if (includeSymbols) {
            contributors.push(this.searchSymbols(query, options.types));
        }

        if (includeText) {
            contributors.push(this.searchText(query));
        }

        return this.mergeResults(query, await Promise.all(contributors));
    }

    public async searchIndexed(query: string, types?: SearchItemType[]): Promise<SearchItem[]> {
        this.startIndexing();

        const parsedQuery = parseSearchQuery(query);

        if (!parsedQuery.term) {
            return [];
        }

        await this.cacheLoadPromise;

        const cacheKey = this.getQueryCacheKey(parsedQuery, types);
        const cachedResults = this.getCachedQueryResults(this.indexedResultCache, cacheKey);

        if (cachedResults) {
            return cachedResults;
        }

        const fileLocationQuery = parsedQuery.exact ? undefined : parseFileLocationQuery(parsedQuery.term);
        const searchTerm = fileLocationQuery?.pathQuery || parsedQuery.term;
        const allowedTypes = types ? new Set(types) : undefined;
        let candidates = allowedTypes
            ? this.allItems.filter(item => allowedTypes.has(item.type))
            : this.allItems.filter(item => item.type === SearchItemType.File || item.type === SearchItemType.Command);

        if (parsedQuery.exact) {
            candidates = candidates.filter(item => this.isDirectContributorMatch(item, parsedQuery.term));
        }

        const contributorLimit = Math.min(Math.max(this.config.performance.maxResults * 5, 100), 1000);
        const directFileResults = fileLocationQuery && (!allowedTypes || allowedTypes.has(SearchItemType.File))
            ? this.findDirectFileLocationMatches(fileLocationQuery, contributorLimit)
            : [];
        const fuzzyResults = await this.searcher.search(candidates, searchTerm, contributorLimit);
        const compactSubsequenceResults = this.searchCompactSubsequenceMatches(candidates, searchTerm, contributorLimit);
        let results = this.deduplicateResults([...directFileResults, ...fuzzyResults, ...compactSubsequenceResults]);

        if (fileLocationQuery) {
            results = results.map(item => this.applyFileLocationToSearchItem(item, fileLocationQuery));
        }

        const rankedResults = this.rankResults(results, parsedQuery)
            .slice(0, contributorLimit);

        this.cacheQueryResults(this.indexedResultCache, cacheKey, rankedResults);

        return rankedResults;
    }

    public async searchSymbols(query: string, types?: SearchItemType[]): Promise<SearchItem[]> {
        const parsedQuery = parseSearchQuery(query);

        if (!parsedQuery.term || !this.config.indexing.includeSymbols) {
            return [];
        }

        const symbolProvider = this.providers.get('symbols') as SymbolSearchProvider | undefined;

        if (!symbolProvider) {
            return [];
        }

        const allowedTypes = types ? new Set(types) : undefined;
        const cacheKey = this.getQueryCacheKey(parsedQuery, types);
        const cachedResults = this.getCachedQueryResults(this.symbolResultCache, cacheKey);

        if (cachedResults) {
            return cachedResults;
        }

        const results = (await symbolProvider.search(parsedQuery.term))
            .filter(item => !allowedTypes || allowedTypes.has(item.type))
            .filter(item => isStrongSymbolNameMatch(item.label, parsedQuery.term));
        const rankedResults = this.rankResults(results, parsedQuery)
            .slice(0, Math.max(this.config.performance.maxResults * 3, 60));

        if (rankedResults.length > 0) {
            this.cacheQueryResults(this.symbolResultCache, cacheKey, rankedResults);
        }

        return rankedResults;
    }

    public async searchText(query: string): Promise<SearchItem[]> {
        const parsedQuery = parseSearchQuery(query);

        if (!parsedQuery.term || !this.config.indexing.includeText || shouldDelayTextSearch(parsedQuery)) {
            return [];
        }

        try {
            const textProvider = this.providers.get('text') as TextSearchProvider | undefined;

            if (!textProvider) {
                return [];
            }

            const cacheKey = this.getQueryCacheKey(parsedQuery);
            const cachedResults = this.getCachedQueryResults(this.textResultCache, cacheKey);

            if (cachedResults) {
                return cachedResults;
            }

            const textResults = await textProvider.search(parsedQuery.textPattern);
            const rankedResults = this.rankResults(textResults, parsedQuery)
                .slice(0, this.config.performance.maxTextResults);

            if (rankedResults.length > 0) {
                this.cacheQueryResults(this.textResultCache, cacheKey, rankedResults);
            }

            return rankedResults;
        } catch (error) {
            console.error('Error performing text search:', error);

            return [];
        }
    }

    public mergeResults(query: string, resultSets: SearchItem[][], limit: number = this.config.performance.maxResults): SearchItem[] {
        const parsedQuery = parseSearchQuery(query);
        const results = this.deduplicateResults(resultSets.flat());

        if (this.config.activity.enabled && this.recentlyModifiedFiles.size > 0) {
            this.boostRecentlyModifiedItems(results);
        }

        return this.rankResults(results, parsedQuery).slice(0, limit);
    }

    public cancelPendingSearches(): void {
        (this.providers.get('text') as TextSearchProvider | undefined)?.cancelSearch();
        (this.providers.get('symbols') as SymbolSearchProvider | undefined)?.cancelPendingSearches();
    }

    private invalidateQueryCaches(): void {
        this.indexedResultCache.clear();
        this.symbolResultCache.clear();
        this.textResultCache.clear();
        (this.providers.get('text') as TextSearchProvider | undefined)?.invalidateCache();
        (this.providers.get('symbols') as SymbolSearchProvider | undefined)?.invalidateCache();
    }

    private invalidateTextIndex(): void {
        (this.providers.get('text') as TextSearchProvider | undefined)?.invalidateIndex();
    }

    private getQueryCacheKey(query: ParsedSearchQuery, types?: SearchItemType[]): string {
        const typeKey = types ? [...types].sort().join(',') : '*';

        return `${query.exact ? 'exact' : 'plain'}:${query.textPattern.toLowerCase()}:${typeKey}`;
    }

    private getCachedQueryResults(cache: Map<string, SearchItem[]>, key: string): SearchItem[] | undefined {
        const results = cache.get(key);

        if (!results) {
            return undefined;
        }

        cache.delete(key);
        cache.set(key, results);

        return [...results];
    }

    private cacheQueryResults(cache: Map<string, SearchItem[]>, key: string, results: SearchItem[]): void {
        cache.set(key, results);

        while (cache.size > SearchService.MAX_QUERY_CACHE_ENTRIES) {
            const oldestKey = cache.keys().next().value as string | undefined;

            if (!oldestKey) {
                break;
            }

            cache.delete(oldestKey);
        }
    }

    private findDirectFileLocationMatches(fileLocationQuery: FileLocationQuery, limit: number): FileSearchItem[] {
        const normalizedPathQuery = normalizeSearchText(fileLocationQuery.pathQuery);
        const matches: Array<{ item: FileSearchItem; rank: number }> = [];
        const fileItems = this.allItems.filter((item): item is FileSearchItem =>
            item.type === SearchItemType.File &&
            !(item as FileSearchItem).isDirectory &&
            'uri' in item &&
            item.uri instanceof vscode.Uri
        );

        for (const item of fileItems) {
            const normalizedPath = normalizeSearchText(item.description || vscode.workspace.asRelativePath(item.uri));
            let rank = 0;

            if (normalizedPath === normalizedPathQuery) {
                rank = 12000;
            } else if (normalizedPath.endsWith(`/${normalizedPathQuery}`) || normalizedPath.endsWith(normalizedPathQuery)) {
                rank = 11000;
            } else if (normalizedPath.includes(normalizedPathQuery)) {
                rank = 9000;
            }

            if (rank <= 0) {
                continue;
            }

            matches.push({
                item: this.applyFileLocationToFileItem(item, fileLocationQuery, 2400),
                rank
            });
        }

        matches.sort((a, b) => b.rank - a.rank || a.item.label.localeCompare(b.item.label));

        return matches.slice(0, limit).map(match => match.item);
    }

    private applyFileLocationToSearchItem(item: SearchItem, fileLocationQuery: FileLocationQuery, priorityBoost: number = 1400): SearchItem {
        if (item.type !== SearchItemType.File || (item as FileSearchItem).isDirectory || !('uri' in item) || !(item.uri instanceof vscode.Uri)) {
            return item;
        }

        return this.applyFileLocationToFileItem(item as FileSearchItem, fileLocationQuery, priorityBoost);
    }

    private applyFileLocationToFileItem(fileItem: FileSearchItem, fileLocationQuery: FileLocationQuery, priorityBoost: number = 1400): FileSearchItem {
        const line = Math.max(1, fileLocationQuery.line);
        const column = Math.max(1, fileLocationQuery.column || 1);
        const position = new vscode.Position(line - 1, column - 1);
        const range = new vscode.Range(position, position);

        return {
            ...fileItem,
            id: `${fileItem.id}:${line}:${column}`,
            range,
            priority: (fileItem.priority || 0) + priorityBoost,
            action: async () => {
                await this.openFileAtLocation(fileItem.uri, line, column);
            }
        };
    }

    private async openFileAtLocation(uri: vscode.Uri, line: number, column: number): Promise<void> {
        const document = await vscode.workspace.openTextDocument(uri);
        const targetLine = Math.min(Math.max(line - 1, 0), Math.max(document.lineCount - 1, 0));
        const lineText = document.lineAt(targetLine).text;
        const targetColumn = Math.min(Math.max(column - 1, 0), lineText.length);
        const position = new vscode.Position(targetLine, targetColumn);
        const range = new vscode.Range(position, position);
        const editor = await vscode.window.showTextDocument(document);

        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }

    private deduplicateResults(items: SearchItem[]): SearchItem[] {
        const deduplicationMap = new Map<string, SearchItem>();
        const semanticLocations = new Set(items
            .filter(item => item.type === SearchItemType.Symbol || item.type === SearchItemType.Class)
            .map(item => this.getSourceLineKey(item))
            .filter((key): key is string => Boolean(key)));

        for (const item of items) {
            if (item.type === SearchItemType.TextMatch) {
                const sourceLineKey = this.getSourceLineKey(item);

                // IDEA's equality providers keep the semantic PSI result when
                // a text usage points at the same declaration. Do the same for
                // language-server symbols and ripgrep rows from one source line.
                if (sourceLineKey && semanticLocations.has(sourceLineKey)) {
                    continue;
                }
            }

            const dedupeKey = this.getDeduplicationKey(item);

            if (!deduplicationMap.has(dedupeKey)) {
                deduplicationMap.set(dedupeKey, item);
            }
        }

        return [...deduplicationMap.values()];
    }

    private getSourceLineKey(item: SearchItem): string | undefined {
        if (!('uri' in item) || !(item.uri instanceof vscode.Uri) || !('range' in item) || !(item.range instanceof vscode.Range)) {
            return undefined;
        }

        return `${item.uri.toString()}:${item.range.start.line}`;
    }

    private searchCompactSubsequenceMatches(items: SearchItem[], query: string, limit: number): SearchItem[] {
        const normalizedQuery = normalizeSearchText(query);

        if (!normalizedQuery) {
            return [];
        }

        const matches: Array<{ item: SearchItem; rank: number }> = [];
        const trimAt = Math.max(limit * 4, limit + 50);

        for (const item of items) {
            const labelRank = getCompactSubsequenceRank(normalizeSearchText(item.label || ''), normalizedQuery, 6200);
            const pathRank = getCompactSubsequenceRank(normalizeSearchText(this.getItemPathText(item)), normalizedQuery, 3600);
            const rank = Math.max(labelRank, pathRank);

            if (rank <= 0) {
                continue;
            }

            item.score = Math.max(item.score || 0, rank / 10000);
            matches.push({ item, rank: rank + (item.priority || 0) });

            if (matches.length > trimAt) {
                matches.sort((a, b) => b.rank - a.rank || a.item.label.localeCompare(b.item.label));
                matches.length = limit;
            }
        }

        matches.sort((a, b) => b.rank - a.rank || a.item.label.localeCompare(b.item.label));

        return matches.slice(0, limit).map(match => match.item);
    }

    /**
     * Get useful items for an empty query, similar to a recent files list.
     */
    public async getDefaultItems(): Promise<SearchItem[]> {
        this.startIndexing();
        await this.cacheLoadPromise;

        const fileItems = this.allItems.filter((item): item is FileSearchItem =>
            item.type === SearchItemType.File &&
            !(item as FileSearchItem).isDirectory &&
            'uri' in item &&
            item.uri instanceof vscode.Uri
        );
        const recentFileItems = fileItems
            .filter(item => this.recentlyModifiedFiles.has(item.uri.toString()))
            .sort((a, b) => {
                return (this.recentlyModifiedFiles.get(b.uri.toString()) || 0) -
                    (this.recentlyModifiedFiles.get(a.uri.toString()) || 0);
            });
        const recentIds = new Set(recentFileItems.map(item => item.id));
        const fallbackFileItems = fileItems
            .filter(item => !recentIds.has(item.id))
            .sort((a, b) => a.label.localeCompare(b.label));

        return [...recentFileItems, ...fallbackFileItems]
            .slice(0, this.config.performance.maxResults);
    }

    private rankResults(results: SearchItem[], query: ParsedSearchQuery): SearchItem[] {
        const rankedResults = results.map(item => ({
            item,
            rank: this.getResultRank(item, query)
        }));

        rankedResults.sort((a, b) => {
            const rankDiff = b.rank - a.rank;

            if (rankDiff !== 0) {
                return rankDiff;
            }

            return a.item.label.localeCompare(b.item.label);
        });

        return rankedResults.map(result => result.item);
    }

    private getResultRank(item: SearchItem, query: ParsedSearchQuery): number {
        const normalizedQuery = normalizeSearchText(query.term);

        if (!normalizedQuery) {
            return item.priority || 0;
        }

        const label = item.label || '';
        const pathText = this.getItemPathText(item);
        const labelRank = getMatchQualityRank(label, query.term, 12000, 10500, 8200, 8000);
        const pathRank = getMatchQualityRank(pathText, query.term, 7600, 6800, 4800, 2800);
        let rank = item.priority || 0;

        // The strongest field determines relevance. A weak path subsequence may
        // break close ties, but must not overwhelm an exact label/content hit.
        rank += Math.max(labelRank, pathRank) + Math.min(labelRank, pathRank) * 0.15;

        if (typeof item.score === 'number') {
            rank += item.score * 100;
        }

        switch (item.type) {
            case SearchItemType.Class:
                // IDEA's All tab emits type-name matches before usages and the
                // general symbol contributor. Keep structs/interfaces/classes
                // visible above textual call sites for camel-hump queries.
                rank += 2500;
                break;

            case SearchItemType.Symbol:
                rank += 400;
                break;

            case SearchItemType.File:
                rank += 250;

                if ((item as FileSearchItem).isDirectory) {
                    rank += normalizeSearchText(item.label) === normalizedQuery ? 2500 : 500;
                }
                break;

            case SearchItemType.Command:
                rank += 100;
                break;

            case SearchItemType.TextMatch:
                if (query.exact) {
                    rank += 5000;
                }

                if (this.isLowValueTextMatch(item)) {
                    rank -= 2500;
                }
                break;
        }

        return rank;
    }

    private isLowValueTextMatch(item: SearchItem): boolean {
        if (item.type !== SearchItemType.TextMatch) {
            return false;
        }

        const label = item.label || '';
        const pathText = this.getItemPathText(item).toLowerCase();

        return label.length > 80 ||
            pathText.includes('go.sum') ||
            /[a-z0-9+/=]{40,}/i.test(label);
    }

    private getItemPathText(item: SearchItem): string {
        if (item.type === SearchItemType.File || item.type === SearchItemType.TextMatch) {
            return item.description || '';
        }

        if ('uri' in item && item.uri instanceof vscode.Uri) {
            return vscode.workspace.asRelativePath(item.uri);
        }

        return `${item.description || ''} ${item.detail || ''}`;
    }

    private isDirectContributorMatch(item: SearchItem, query: string): boolean {
        const normalizedQuery = normalizeSearchText(query);

        return normalizeSearchText(item.label).includes(normalizedQuery) ||
            normalizeSearchText(this.getItemPathText(item)).includes(normalizedQuery);
    }

    /**
     * Boost items related to recently modified files
     */
    private boostRecentlyModifiedItems(results: SearchItem[]): void {
        const activityWeight = this.config.activity.weight;
        const now = Date.now();
        const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds

        for (const item of results) {
            // Check if this item is related to a recently modified file
            if (item.type === SearchItemType.File && 'uri' in item) {
                const fileItem = item as { uri: vscode.Uri };
                const timestamp = this.recentlyModifiedFiles.get(fileItem.uri.toString());

                if (timestamp) {
                    // Calculate a recency score (1.0 for just modified, decreasing over time)
                    const age = now - timestamp;
                    const recencyScore = Math.max(0, 1 - (age / oneHour));

                    // Apply the recency boost based on configuration weight
                    const boost = 1 + (recencyScore * activityWeight);

                    // Boost the result's score if it has one
                    if ('score' in item && typeof item.score === 'number') {
                        item.score *= boost;
                    }
                }
            }
            // Boost symbols from recently modified files
            else if (item.type === SearchItemType.Symbol && 'uri' in item) {
                const symbolItem = item as { uri: vscode.Uri };
                const timestamp = this.recentlyModifiedFiles.get(symbolItem.uri.toString());

                if (timestamp) {
                    const age = now - timestamp;
                    const recencyScore = Math.max(0, 1 - (age / oneHour));
                    const boost = 1 + (recencyScore * activityWeight * 0.5); // Slightly less boost for symbols

                    if ('score' in item && typeof item.score === 'number') {
                        item.score *= boost;
                    }
                }
            }
        }
    }

    /**
     * Run benchmarks for different search libraries
     */
    public async runBenchmarks(query: string): Promise<Record<string, number>> {
        const benchmarks: Record<string, number> = {};
        const searchers = SearchFactory.getAllSearchers();

        for (const searcher of searchers) {
            const startTime = performance.now();

            // Run search 5 times and take average
            for (let i = 0; i < 5; i++) {
                await searcher.search(this.allItems, query, 100);
            }

            const endTime = performance.now();
            const averageTime = (endTime - startTime) / 5;

            benchmarks[searcher.name] = averageTime;
        }

        return benchmarks;
    }
}

interface CachedSearchIndexHeader {
    version: number;
    recentFiles?: Array<[string, number]>;
}

interface CachedSearchItem {
    id: string;
    label: string;
    description: string;
    detail: string;
    type: SearchItemType;
    priority?: number;
    uri?: string;
    isDirectory?: boolean;
    range?: CachedRange;
    symbolKind?: vscode.SymbolKind;
    symbolGroup?: SymbolKindGroup;
    command?: string;
    args?: any[];
}

interface CachedRange {
    start: {
        line: number;
        character: number;
    };
    end: {
        line: number;
        character: number;
    };
}

function serializeRange(range: vscode.Range): CachedRange {
    return {
        start: {
            line: range.start.line,
            character: range.start.character
        },
        end: {
            line: range.end.line,
            character: range.end.character
        }
    };
}

function deserializeRange(range: CachedRange): vscode.Range {
    return new vscode.Range(
        new vscode.Position(range.start.line, range.start.character),
        new vscode.Position(range.end.line, range.end.character)
    );
}

function parseFileLocationQuery(query: string): FileLocationQuery | undefined {
    const match = /^(.*):(\d+)(?::(\d+))?$/.exec(query.trim());

    if (!match) {
        return undefined;
    }

    const pathQuery = match[1].trim();
    const line = Number.parseInt(match[2], 10);
    const column = match[3] ? Number.parseInt(match[3], 10) : undefined;

    if (!pathQuery || !Number.isFinite(line) || line < 1) {
        return undefined;
    }

    if (!/[\\/]/.test(pathQuery) && !/\.[^./\\:]+$/.test(pathQuery)) {
        return undefined;
    }

    if (column !== undefined && (!Number.isFinite(column) || column < 1)) {
        return undefined;
    }

    return {
        pathQuery,
        line,
        column
    };
}

function normalizeSearchText(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function shouldDelayTextSearch(query: ParsedSearchQuery): boolean {
    return !query.exact && /^[A-Za-z0-9_$]+$/.test(query.term) && query.term.length < 3;
}

function isStrongSymbolNameMatch(label: string, query: string): boolean {
    const normalizedLabel = normalizeSearchText(label);
    const normalizedQuery = normalizeSearchText(query);

    if (!normalizedLabel || !normalizedQuery) {
        return false;
    }

    if (normalizedLabel.includes(normalizedQuery)) {
        return true;
    }

    return getIdeaNameMatchScore(label, query) > 0;
}

function getMatchQualityRank(
    text: string,
    query: string,
    exactRank: number,
    prefixRank: number,
    substringRank: number,
    subsequenceRank: number
): number {
    const normalizedText = normalizeSearchText(text);
    const normalizedQuery = normalizeSearchText(query);

    if (!normalizedText || !normalizedQuery) {
        return 0;
    }

    if (normalizedText === normalizedQuery) {
        return text === query ? exactRank + 300 : exactRank;
    }

    if (normalizedText.startsWith(normalizedQuery)) {
        return text.startsWith(query) ? prefixRank + 150 : prefixRank;
    }

    const rawIndex = text.toLowerCase().indexOf(query.toLowerCase());

    if (rawIndex >= 0) {
        const segmentBonus = isIdentifierSegment(text, rawIndex, rawIndex + query.length) ? 2200 : 0;

        return substringRank + segmentBonus - Math.min(rawIndex, 500);
    }

    const normalizedIndex = normalizedText.indexOf(normalizedQuery);

    if (normalizedIndex >= 0) {
        return substringRank + 800 - Math.min(normalizedIndex, 500);
    }

    return Math.max(
        getIdeaNameMatchScore(text, query, subsequenceRank),
        getCompactSubsequenceRank(normalizedText, normalizedQuery, subsequenceRank)
    );
}

function isIdentifierSegment(text: string, start: number, end: number): boolean {
    const before = start > 0 ? text[start - 1] : '';
    const first = text[start] || '';
    const last = end > start ? text[end - 1] : '';
    const after = end < text.length ? text[end] : '';
    const startsAtBoundary = !before || /[^A-Za-z0-9_$]/.test(before) ||
        (/[a-z0-9]/.test(before) && /[A-Z]/.test(first));
    const endsAtBoundary = !after || /[^A-Za-z0-9_$]/.test(after) ||
        (/[a-z0-9]/.test(last) && /[A-Z]/.test(after));

    return startsAtBoundary && endsAtBoundary;
}

function getCompactSubsequenceRank(text: string, query: string, base: number): number {
    if (!text || !query || text.includes(query)) {
        return 0;
    }

    let firstMatch = -1;
    let lastMatch = -1;
    let gapPenalty = 0;

    for (const char of query) {
        const match = text.indexOf(char, lastMatch + 1);

        if (match === -1) {
            return 0;
        }

        if (firstMatch === -1) {
            firstMatch = match;
        }

        if (lastMatch >= 0) {
            gapPenalty += Math.min(match - lastMatch - 1, 20) * 40;
        }

        lastMatch = match;
    }

    const span = lastMatch - firstMatch + 1;

    if (span > query.length * 4 + 16) {
        return 0;
    }

    return Math.max(0, base - gapPenalty - Math.min(firstMatch, 500));
}
