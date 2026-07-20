import * as vscode from 'vscode';
import { mapSymbolKindToGroup, SearchItemType, SearchProvider, SymbolKindGroup, SymbolSearchItem } from '../core/types';
import { ExclusionPatterns } from '../utils/exclusions';
import { isWorkspaceFile } from '../utils/workspace';

/**
 * On-demand symbol contributor backed by the active language servers.
 * This mirrors IDEA's contributor model: symbols are queried for the current
 * pattern instead of pre-scanning an arbitrary prefix of workspace files.
 */
export class SymbolSearchProvider implements SearchProvider {
    private static readonly MAX_CACHE_ENTRIES = 30;

    private activeQuery: string | undefined;
    private activeSearch: Promise<SymbolSearchItem[]> | undefined;
    private pendingRequest: { query: string; resolve: (items: SymbolSearchItem[]) => void } | undefined;
    private resultCache = new Map<string, SymbolSearchItem[]>();
    private cacheGeneration = 0;

    public async getItems(): Promise<SymbolSearchItem[]> {
        return [];
    }

    public async refresh(): Promise<void> {
        this.invalidateCache();
    }

    public cancelPendingSearches(): void {
        this.pendingRequest?.resolve([]);
        this.pendingRequest = undefined;
    }

    public search(query: string): Promise<SymbolSearchItem[]> {
        const normalizedQuery = query.trim();

        if (!normalizedQuery) {
            return Promise.resolve([]);
        }

        const cacheKey = normalizedQuery.toLowerCase();
        const cachedResults = this.resultCache.get(cacheKey);

        if (cachedResults) {
            this.resultCache.delete(cacheKey);
            this.resultCache.set(cacheKey, cachedResults);

            return Promise.resolve([...cachedResults]);
        }

        if (!this.activeSearch) {
            return this.startSearch(normalizedQuery, cacheKey);
        }

        if (this.activeQuery === normalizedQuery) {
            return this.activeSearch;
        }

        return new Promise(resolve => {
            // Only the newest query is useful to the UI. Resolve an older queued
            // request immediately instead of building an unbounded gopls queue.
            this.pendingRequest?.resolve([]);
            this.pendingRequest = { query: normalizedQuery, resolve };
        });
    }

    public invalidateCache(): void {
        this.cacheGeneration++;
        this.resultCache.clear();
        this.cancelPendingSearches();
    }

    private startSearch(query: string, cacheKey: string = query.toLowerCase()): Promise<SymbolSearchItem[]> {
        const cacheGeneration = this.cacheGeneration;
        const search = this.fetchSymbols(query).then(items => {
            if (cacheGeneration === this.cacheGeneration) {
                this.cacheResults(cacheKey, items);
            }

            return items;
        });

        this.activeQuery = query;
        this.activeSearch = search;

        void search.finally(() => {
            if (this.activeSearch !== search) {
                return;
            }

            this.activeSearch = undefined;
            this.activeQuery = undefined;

            const pending = this.pendingRequest;

            if (pending) {
                this.pendingRequest = undefined;
                void this.startSearch(pending.query).then(pending.resolve);
            }
        });

        return search;
    }

    private cacheResults(key: string, results: SymbolSearchItem[]): void {
        this.resultCache.set(key, results);

        while (this.resultCache.size > SymbolSearchProvider.MAX_CACHE_ENTRIES) {
            const oldestKey = this.resultCache.keys().next().value as string | undefined;

            if (!oldestKey) {
                break;
            }

            this.resultCache.delete(oldestKey);
        }
    }

    private async fetchSymbols(query: string): Promise<SymbolSearchItem[]> {
        try {
            const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider',
                query
            ) || [];
            const unique = new Map<string, SymbolSearchItem>();

            for (const symbol of symbols) {
                if (!isWorkspaceFile(symbol.location.uri) || ExclusionPatterns.shouldExclude(symbol.location.uri)) {
                    continue;
                }

                const item = this.convertToSearchItem(symbol);

                unique.set(item.id, item);
            }

            return [...unique.values()];
        } catch (error) {
            console.error('Error searching workspace symbols:', error);

            return [];
        }
    }

    private convertToSearchItem(symbol: vscode.SymbolInformation): SymbolSearchItem {
        const symbolGroup = mapSymbolKindToGroup(symbol.kind);
        const type = symbolGroup === SymbolKindGroup.Class ? SearchItemType.Class : SearchItemType.Symbol;
        const range = symbol.location.range;

        return {
            id: `symbol:${symbol.name}:${symbol.location.uri.toString()}:${range.start.line}:${range.start.character}`,
            label: symbol.name,
            description: `${this.getSymbolKindName(symbol.kind)}${symbol.containerName ? ` - ${symbol.containerName}` : ''}`,
            detail: symbol.location.uri.fsPath,
            type,
            uri: symbol.location.uri,
            range,
            symbolKind: symbol.kind,
            symbolGroup,
            priority: this.getSymbolPriority(symbol.kind),
            iconPath: new vscode.ThemeIcon(type === SearchItemType.Class ? 'symbol-class' : 'symbol-method'),
            action: async () => {
                const document = await vscode.workspace.openTextDocument(symbol.location.uri);
                const editor = await vscode.window.showTextDocument(document);

                editor.selection = new vscode.Selection(range.start, range.start);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            }
        };
    }

    private getSymbolPriority(kind: vscode.SymbolKind): number {
        switch (mapSymbolKindToGroup(kind)) {
            case SymbolKindGroup.Class:
                return 100;

            case SymbolKindGroup.Function:
                return 90;

            case SymbolKindGroup.Variable:
                return 70;

            default:
                return 50;
        }
    }

    private getSymbolKindName(kind: vscode.SymbolKind): string {
        return vscode.SymbolKind[kind] || 'Symbol';
    }
}
