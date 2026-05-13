import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { CommandSearchItem, FileSearchItem, FuzzySearcher, SearchEverywhereConfig, SearchItem, SearchItemType, SearchProvider, SymbolKindGroup, SymbolSearchItem, TextMatchItem } from './types';
import { FileSearchProvider } from '../providers/file-provider';
import { CommandSearchProvider } from '../providers/command-provider';
import { DocumentSymbolProvider } from '../providers/document-symbol-provider';
import { TextSearchProvider } from '../providers/text-provider';
import { getConfiguration } from '../utils/config';
import { SearchFactory } from '../search/search-factory';
import { Debouncer } from '../utils/debouncer';
import { isWorkspaceFile } from '../utils/workspace';
import { ExclusionPatterns } from '../utils/exclusions';

interface RgMatch {
    type: string;
    data?: {
        path?: { text?: string };
        lines?: { text?: string };
        line_number?: number;
    };
}

interface ParsedFunction {
    name: string;
    offset: number;
    container?: string;
    isMethod: boolean;
}

/**
 * Main service for coordinating search functionality
 */
export class SearchService {
    private static readonly CACHE_VERSION = 9;
    private static readonly MAX_CACHE_LOAD_BYTES = 64 * 1024 * 1024;

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
    private hasBuiltIndex = false;

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
        // Symbols are found on demand; pulling docSymbols here can silently run
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
        void this.saveIndexCache();

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

        // Add symbol providers
        if (this.config.indexing.includeSymbols) {
            this.providers.set('docSymbols', new DocumentSymbolProvider());
        }

        // Add command provider
        if (this.config.indexing.includeCommands) {
            this.providers.set('commands', new CommandSearchProvider());
        }

        // Add text search provider
        if (this.config.indexing.includeText) {
            this.providers.set('text', new TextSearchProvider());
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
            .filter(([name]) => force || name !== 'docSymbols');

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
        this.hasBuiltIndex = true;
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

            case 'docSymbols':
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
                return 'docSymbols';

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

    private async findFunctionCandidatesInFolder(folder: vscode.WorkspaceFolder, query: string, limit: number): Promise<SymbolSearchItem[]> {
        return new Promise(resolve => {
            const results: SymbolSearchItem[] = [];
            const args = this.buildFunctionQueryRgArgs(query);
            const child = spawn(this.getRgCommand(), args, {
                cwd: folder.uri.fsPath,
                windowsHide: true
            });
            let buffer = '';

            child.stdout.setEncoding('utf8');
            child.stdout.on('data', chunk => {
                buffer += chunk;
                buffer = this.processFunctionRgOutput(buffer, folder, results, limit);

                if (results.length >= limit) {
                    child.kill();
                }
            });

            child.stderr.setEncoding('utf8');
            child.stderr.on('data', chunk => {
                console.log(`ripgrep function query stderr: ${chunk}`);
            });

            child.on('error', error => {
                console.log(`ripgrep function query failed: ${error}`);
                resolve(results);
            });

            child.on('close', () => {
                if (buffer.trim()) {
                    this.processFunctionRgOutput(`${buffer}\n`, folder, results, limit);
                }

                resolve(results);
            });
        });
    }

    private buildFunctionQueryRgArgs(query: string): string[] {
        const args = [
            '--json',
            '--ignore-case',
            '--line-number',
            '--column',
            '.'
        ];

        for (const pattern of this.buildFunctionDeclarationRegexes(query)) {
            args.splice(args.length - 1, 0, '-e', pattern);
        }

        for (const pattern of this.getFunctionFileGlobs()) {
            args.splice(args.length - 1, 0, '--glob', pattern);
        }

        for (const pattern of ExclusionPatterns.getExclusionPatterns()) {
            args.splice(args.length - 1, 0, '--glob', `!${pattern}`);
        }

        return args;
    }

    private buildFunctionDeclarationRegexes(query: string): string[] {
        const namePattern = this.buildIdentifierSubsequenceRegex(query);

        return [
            `^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${namePattern}\\s*(?:\\[[^\\]]+\\]\\s*)?\\(`,
            `^\\s*(?:async\\s+)?def\\s+${namePattern}\\s*\\(`,
            `^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${namePattern}\\s*\\(`,
            `^\\s*(?:export\\s+)?(?:const|let|var)\\s+${namePattern}\\s*=`,
            `^\\s*(?:async\\s+)?${namePattern}\\s*\\([^)]*\\)\\s*\\{`,
            `^\\s*(?:(?:public|private|protected|static|final|native|synchronized|abstract|inline|extern|virtual|constexpr|const|unsigned|signed|long|short|struct|class|[\\w:<>&*\\[\\]])+\\s+)+${namePattern}\\s*\\(`
        ];
    }

    private buildIdentifierSubsequenceRegex(query: string): string {
        const chars = normalizeSearchText(query)
            .split('')
            .map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('[\\w$]*?');

        return `(?:[A-Za-z_$][\\w$]*?)?${chars}[\\w$]*?`;
    }

    private getFunctionFileGlobs(): string[] {
        return [
            '*.go',
            '*.py',
            '*.java',
            '*.c',
            '*.h',
            '*.cpp',
            '*.hpp',
            '*.js',
            '*.jsx',
            '*.ts',
            '*.tsx',
            '*.vue'
        ];
    }

    private processFunctionRgOutput(
        buffer: string,
        folder: vscode.WorkspaceFolder,
        results: SymbolSearchItem[],
        limit: number
    ): string {
        const lines = buffer.split('\n');
        const remainder = lines.pop() || '';

        for (const line of lines) {
            if (results.length >= limit || !line.trim()) {
                continue;
            }

            try {
                const event = JSON.parse(line) as RgMatch;

                if (event.type !== 'match' || !event.data) {
                    continue;
                }

                const item = this.createFunctionSymbolItem(folder, event.data);

                if (item) {
                    results.push(item);
                }
            } catch (error) {
                console.log(`Error parsing function index output: ${error}`);
            }
        }

        return remainder;
    }

    private createFunctionSymbolItem(folder: vscode.WorkspaceFolder, data: NonNullable<RgMatch['data']>): SymbolSearchItem | undefined {
        const relativePath = data.path?.text;
        const lineText = data.lines?.text;
        const lineNumber = data.line_number;

        if (!relativePath || !lineText || !lineNumber) {
            return undefined;
        }

        const uri = vscode.Uri.joinPath(folder.uri, relativePath);

        if (!isWorkspaceFile(uri) || ExclusionPatterns.shouldExclude(uri)) {
            return undefined;
        }

        const parsedFunction = this.parseFunctionLine(uri.fsPath, lineText);

        if (!parsedFunction) {
            return undefined;
        }

        const kind = parsedFunction.isMethod ? vscode.SymbolKind.Method : vscode.SymbolKind.Function;
        const range = new vscode.Range(
            new vscode.Position(lineNumber - 1, parsedFunction.offset),
            new vscode.Position(lineNumber - 1, parsedFunction.offset + parsedFunction.name.length)
        );

        return {
            id: `symbol:${parsedFunction.name}:${uri.toString()}:${range.start.line}:${range.start.character}`,
            label: parsedFunction.name,
            description: parsedFunction.isMethod && parsedFunction.container ? `Method - ${parsedFunction.container}` : 'Function',
            detail: uri.fsPath,
            type: SearchItemType.Symbol,
            uri,
            range,
            symbolKind: kind,
            symbolGroup: SymbolKindGroup.Function,
            priority: 90,
            iconPath: new vscode.ThemeIcon('symbol-method'),
            action: async () => {
                const document = await vscode.workspace.openTextDocument(uri);
                const editor = await vscode.window.showTextDocument(document);

                editor.selection = new vscode.Selection(range.start, range.start);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            }
        };
    }

    private parseFunctionLine(filePath: string, lineText: string): ParsedFunction | undefined {
        const lowerPath = filePath.toLowerCase();

        if (lowerPath.endsWith('.go')) {
            return this.parseFunctionWithRegex(lineText, /^(\s*)func\s+(?:\(([^)]*)\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]+\]\s*)?\(/, 3, 2);
        }

        if (lowerPath.endsWith('.py')) {
            return this.parseFunctionWithRegex(lineText, /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, 2);
        }

        if (/\.(?:js|jsx|ts|tsx|vue)$/.test(lowerPath)) {
            return this.parseJsLikeFunctionLine(lineText);
        }

        if (/\.(?:java|c|h|cpp|hpp)$/.test(lowerPath)) {
            return this.parseCStyleFunctionLine(lineText);
        }

        return undefined;
    }

    private parseJsLikeFunctionLine(lineText: string): ParsedFunction | undefined {
        return this.parseFunctionWithRegex(lineText, /^(\s*)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, 2) ||
            this.parseFunctionWithRegex(lineText, /^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, 2) ||
            this.parseFunctionWithRegex(lineText, /^(\s*)(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/, 2, undefined, true);
    }

    private parseCStyleFunctionLine(lineText: string): ParsedFunction | undefined {
        const trimmed = lineText.trim();

        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.endsWith(';')) {
            return undefined;
        }

        return this.parseFunctionWithRegex(
            lineText,
            /^(\s*)(?:(?:public|private|protected|static|final|native|synchronized|abstract|inline|extern|virtual|constexpr|const|unsigned|signed|long|short|struct|class|[\w:<>\*\&\[\]])+\s+)+([A-Za-z_$][\w$]*)\s*\(/,
            2
        );
    }

    private parseFunctionWithRegex(
        lineText: string,
        regex: RegExp,
        nameGroup: number,
        containerGroup?: number,
        forceMethod: boolean = false
    ): ParsedFunction | undefined {
        const match = regex.exec(lineText);

        if (!match) {
            return undefined;
        }

        const name = match[nameGroup];
        const container = containerGroup !== undefined ? match[containerGroup]?.trim() : undefined;
        const offset = lineText.indexOf(name, match[1]?.length || 0);

        if (!name || offset < 0) {
            return undefined;
        }

        return {
            name,
            offset,
            container,
            isMethod: forceMethod || Boolean(container)
        };
    }

    private getRgCommand(): string {
        const bundledRg = path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');

        if (fs.existsSync(bundledRg)) {
            return bundledRg;
        }

        return 'rg';
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

            if (item && this.isWorkspaceScopedItem(item) && !this.isExcludedItem(item)) {
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
            return {
                ...baseItem,
                uri: item.uri.toString()
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
                iconPath: new vscode.ThemeIcon('file'),
                priority: item.priority,
                action: async () => {
                    await vscode.window.showTextDocument(uri);
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
     * Search for items matching the query
     */
    public async search(query: string, options: { includeText?: boolean; includeFunctions?: boolean; textOnly?: boolean } = {}): Promise<SearchItem[]> {
        this.startIndexing();

        if (!query.trim()) {
            return [];
        }

        if (options.textOnly) {
            return this.searchText(query);
        }

        await this.cacheLoadPromise;

        let results: SearchItem[] = [];
        const queryLimit = Math.min(this.config.performance.maxResults * 5, 1000);

        // Perform fuzzy search on indexed items
        const fuzzyResults = await this.searcher.search(
            this.allItems,
            query,
            queryLimit
        );
        const compactSubsequenceResults = this.searchCompactSubsequenceMatches(query, queryLimit);

        // The active matcher scores both label and path, so keep this to one full scan.
        results = this.deduplicateResults([...fuzzyResults, ...compactSubsequenceResults]);

        if (options.includeFunctions !== false && this.shouldSearchFunctionNamesOnDemand(query, results.length)) {
            const functionResults = await this.searchFunctionNamesOnDemand(query, queryLimit);

            results = this.deduplicateResults([...results, ...functionResults]);
        }

        // Text search uses its own in-memory line index. It is intentionally last because
        // large workspaces can make full-text matching noticeably slower than item lookup.
        if (this.config.indexing.includeText && options.includeText) {
            const textResults = await this.searchText(query);

            results = this.deduplicateResults([...results, ...textResults]);
        }

        // Boost recently modified files
        if (this.config.activity.enabled && this.recentlyModifiedFiles.size > 0) {
            this.boostRecentlyModifiedItems(results);
        }
        // Apply IDEA-style ranking across labels, paths, symbols, and text matches.
        this.sortResultsByRelevance(results, query, false);

        if (!options.textOnly) {
            results = this.moveTextMatchesToBottom(results);
        }

        // Limit to max results
        return results.slice(0, this.config.performance.maxResults);
    }

    public async searchText(query: string): Promise<SearchItem[]> {
        if (!query.trim() || !this.config.indexing.includeText) {
            return [];
        }

        try {
            const textProvider = this.providers.get('text') as TextSearchProvider;

            if (!textProvider) {
                return [];
            }

            const textResults = (await textProvider.search(query))
                .map(item => this.convertGoFunctionTextMatch(item));

            this.sortResultsByRelevance(textResults, query, true);

            return textResults.slice(0, this.config.performance.maxTextResults);
        } catch (error) {
            console.error('Error performing text search:', error);

            return [];
        }
    }

    public async searchFunctionNames(query: string, limit: number = this.config.performance.maxResults): Promise<SearchItem[]> {
        return this.searchFunctionNamesOnDemand(query, limit);
    }

    private convertGoFunctionTextMatch(item: TextMatchItem): SearchItem {
        if (!item.uri.fsPath.endsWith('.go')) {
            return item;
        }

        const lineText = item.lineText || item.label;
        const match = /^(\s*)func\s+(?:\(([^)]*)\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]+\]\s*)?\(/.exec(lineText);

        if (!match) {
            return item;
        }

        const receiver = match[2]?.trim();
        const name = match[3];
        const nameOffset = lineText.indexOf(name, match[1].length + 4);

        if (nameOffset < 0) {
            return item;
        }

        const kind = receiver ? vscode.SymbolKind.Method : vscode.SymbolKind.Function;
        const start = new vscode.Position(item.range.start.line, nameOffset);
        const end = new vscode.Position(item.range.start.line, nameOffset + name.length);
        const range = new vscode.Range(start, end);
        const symbolItem: SymbolSearchItem = {
            id: `symbol:${name}:${item.uri.toString()}:${range.start.line}:${range.start.character}`,
            label: name,
            description: receiver ? `Method - ${receiver}` : 'Function',
            detail: item.uri.fsPath,
            type: SearchItemType.Symbol,
            uri: item.uri,
            range,
            symbolKind: kind,
            symbolGroup: SymbolKindGroup.Function,
            priority: 90,
            iconPath: new vscode.ThemeIcon('symbol-method'),
            action: async () => {
                const document = await vscode.workspace.openTextDocument(item.uri);
                const editor = await vscode.window.showTextDocument(document);

                editor.selection = new vscode.Selection(range.start, range.start);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            }
        };

        return symbolItem;
    }

    private moveTextMatchesToBottom(results: SearchItem[]): SearchItem[] {
        const nonTextResults = results.filter(item => item.type !== SearchItemType.TextMatch);
        const textResults = results.filter(item => item.type === SearchItemType.TextMatch);

        return [...nonTextResults, ...textResults];
    }

    private deduplicateResults(items: SearchItem[]): SearchItem[] {
        const deduplicationMap = new Map<string, SearchItem>();

        for (const item of items) {
            const dedupeKey = this.getDeduplicationKey(item);

            if (!deduplicationMap.has(dedupeKey)) {
                deduplicationMap.set(dedupeKey, item);
            }
        }

        return [...deduplicationMap.values()];
    }

    private searchCompactSubsequenceMatches(query: string, limit: number): SearchItem[] {
        const normalizedQuery = normalizeSearchText(query);

        if (!normalizedQuery) {
            return [];
        }

        const matches: Array<{ item: SearchItem; rank: number }> = [];
        const trimAt = Math.max(limit * 4, limit + 50);

        for (const item of this.allItems) {
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

    private shouldSearchFunctionNamesOnDemand(query: string, resultCount: number): boolean {
        const normalizedQuery = normalizeSearchText(query);

        return normalizedQuery.length >= 3 &&
            this.isFunctionNameQuery(query) &&
            resultCount < this.config.performance.maxResults;
    }

    private async searchFunctionNamesOnDemand(query: string, limit: number): Promise<SearchItem[]> {
        const normalizedQuery = normalizeSearchText(query);

        if (!normalizedQuery || normalizedQuery.length < 3 || !this.isFunctionNameQuery(query)) {
            return [];
        }

        const matches: Array<{ item: SearchItem; rank: number }> = [];
        const maxScanResults = Math.max(this.config.performance.maxResults * 20, 2000);

        for (const folder of vscode.workspace.workspaceFolders || []) {
            const items = await this.findFunctionCandidatesInFolder(folder, normalizedQuery, maxScanResults);

            for (const item of items) {
                const label = normalizeSearchText(item.label || '');
                const pathText = normalizeSearchText(this.getItemPathText(item));
                const exactRank = label.includes(normalizedQuery) ? 10000 : 0;
                const rank = Math.max(
                    exactRank,
                    getCompactSubsequenceRank(label, normalizedQuery, 6200),
                    getCompactSubsequenceRank(pathText, normalizedQuery, 3600)
                );

                if (rank <= 0) {
                    continue;
                }

                item.score = Math.max(item.score || 0, rank / 10000);
                matches.push({ item, rank: rank + (item.priority || 0) });
            }
        }

        matches.sort((a, b) => b.rank - a.rank || a.item.label.localeCompare(b.item.label));

        return matches.slice(0, limit).map(match => match.item);
    }

    private isFunctionNameQuery(query: string): boolean {
        const trimmed = query.trim();

        return /^[A-Za-z0-9_$]+$/.test(trimmed);
    }

    /**
     * Get useful items for an empty query, similar to a recent files list.
     */
    public async getDefaultItems(): Promise<SearchItem[]> {
        this.startIndexing();
        await this.cacheLoadPromise;

        const fileItems = this.allItems.filter((item): item is FileSearchItem =>
            item.type === SearchItemType.File &&
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

    private sortResultsByRelevance(results: SearchItem[], query: string, textOnlyMode: boolean): void {
        const normalizedQuery = normalizeSearchText(query);
        const rawQuery = query.trim().toLowerCase();

        results.sort((a, b) => {
            const rankDiff = this.getResultRank(b, normalizedQuery, rawQuery, textOnlyMode) -
                this.getResultRank(a, normalizedQuery, rawQuery, textOnlyMode);

            if (rankDiff !== 0) {
                return rankDiff;
            }

            return a.label.localeCompare(b.label);
        });
    }

    private getResultRank(item: SearchItem, normalizedQuery: string, rawQuery: string, textOnlyMode: boolean): number {
        const label = item.label || '';
        const labelLower = label.toLowerCase();
        const normalizedLabel = normalizeSearchText(label);
        const pathText = this.getItemPathText(item);
        const normalizedPath = normalizeSearchText(pathText);
        let rank = item.priority || 0;

        if (normalizedLabel === normalizedQuery) {
            rank += 10000;
        } else if (labelLower === rawQuery) {
            rank += 9800;
        } else if (normalizedLabel.startsWith(normalizedQuery)) {
            rank += 9000;
        } else {
            const labelIndex = normalizedLabel.indexOf(normalizedQuery);

            if (labelIndex >= 0) {
                rank += 7600 - Math.min(labelIndex, 500);
            }
        }

        rank += getCompactSubsequenceRank(normalizedLabel, normalizedQuery, 6200);

        if (normalizedPath === normalizedQuery) {
            rank += 8200;
        } else if (normalizedPath.endsWith(normalizedQuery)) {
            rank += 7000;
        } else {
            const pathIndex = normalizedPath.indexOf(normalizedQuery);

            if (pathIndex >= 0) {
                rank += 5200 - Math.min(pathIndex, 1000);
            }
        }

        rank += getCompactSubsequenceRank(normalizedPath, normalizedQuery, 3600);

        if (typeof item.score === 'number') {
            rank += item.score * 100;
        }

        switch (item.type) {
            case SearchItemType.Class:
                rank += 900;
                break;

            case SearchItemType.Symbol:
                rank += 800;
                break;

            case SearchItemType.File:
                rank += 700;
                break;

            case SearchItemType.TextMatch:
                rank -= textOnlyMode ? 1800 : 9000;

                if (this.isLowValueTextMatch(item)) {
                    rank -= 2500;
                }
                break;

            case SearchItemType.Command:
                rank += 100;
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
        if ('uri' in item && item.uri instanceof vscode.Uri) {
            return `${vscode.workspace.asRelativePath(item.uri)} ${item.detail || ''}`;
        }

        return `${item.description || ''} ${item.detail || ''}`;
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

function normalizeSearchText(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
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
