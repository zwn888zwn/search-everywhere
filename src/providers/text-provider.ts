import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SearchItemType, SearchProvider, TextMatchItem } from '../core/types';
import { ExclusionPatterns } from '../utils/exclusions';
import Logger from '../utils/logging';
import { isWorkspaceFile } from '../utils/workspace';

interface RgMatch {
    type: string;
    data?: {
        path?: { text?: string };
        lines?: { text?: string };
        line_number?: number;
        submatches?: Array<{
            match?: { text?: string };
            start: number;
            end: number;
        }>;
    };
}

interface TextSearchQueryPlan {
    pattern: string;
    useRegex: boolean;
}

interface PersistedTextIndexHeader {
    version: number;
    workspaceSignature: string;
    complete: boolean;
}

interface PersistedTextIndexFile {
    uri: string;
    relativePath: string;
    content: string;
}

interface IndexedTextFile extends PersistedTextIndexFile {
    parsedUri: vscode.Uri;
    lowerContent: string;
    lineStarts: number[];
}

const RG_EXECUTABLE_NAME = process.platform === 'win32' ? 'rg.exe' : 'rg';

/**
 * Provides full-text results from a persistent trigram index. Ripgrep remains
 * the correctness fallback while the index is unavailable or capacity-limited.
 */
export class TextSearchProvider implements SearchProvider {
    private static readonly MAX_CACHE_ENTRIES = 30;
    private static readonly INDEX_VERSION = 1;
    private static readonly INDEX_FILE_NAME = 'text-index-v1.jsonl';

    private searchResults: TextMatchItem[] = [];
    private currentProcess: ReturnType<typeof spawn> | undefined;
    private searchGeneration = 0;
    private indexGeneration = 0;
    private resultCache = new Map<string, TextMatchItem[]>();
    private indexedFiles: IndexedTextFile[] = [];
    private trigramIndex = new Map<string, number[]>();
    private indexReady = false;
    private indexComplete = false;
    private cacheLoadPromise: Promise<number> | undefined;
    private refreshPromise: Promise<void> | undefined;
    private staleCacheDeletePromise = Promise.resolve();

    constructor(
        private storageUri?: vscode.Uri,
        private maxFileSizeBytes: number = 1024 * 1024,
        private maxIndexBytes: number = 20 * 1024 * 1024
    ) {}

    public async getItems(): Promise<TextMatchItem[]> {
        return [];
    }

    public async refresh(): Promise<void> {
        this.invalidateCache();

        if (!this.storageUri || this.maxFileSizeBytes <= 0 || this.maxIndexBytes <= 0) {
            return;
        }

        if (!this.refreshPromise) {
            const generation = ++this.indexGeneration;

            this.refreshPromise = this.buildAndPersistIndex(generation).finally(() => {
                this.refreshPromise = undefined;
            });
        }

        return this.refreshPromise;
    }

    public async search(query: string): Promise<TextMatchItem[]> {
        const normalizedQuery = query.trim();
        const cacheKey = normalizedQuery.toLowerCase();
        const generation = ++this.searchGeneration;

        this.stopCurrentProcess();

        if (!normalizedQuery || !vscode.workspace.workspaceFolders?.length) {
            this.searchResults = [];

            return this.searchResults;
        }

        const cachedResults = this.resultCache.get(cacheKey);

        if (cachedResults) {
            this.resultCache.delete(cacheKey);
            this.resultCache.set(cacheKey, cachedResults);
            this.searchResults = cachedResults;

            return [...cachedResults];
        }

        if (this.indexReady && this.indexComplete) {
            const indexedResults = this.searchIndex(normalizedQuery, generation);

            if (generation !== this.searchGeneration) {
                return [];
            }

            this.searchResults = indexedResults;
            this.cacheResults(cacheKey, indexedResults);

            return indexedResults;
        }

        const results: TextMatchItem[] = [];

        for (const folder of vscode.workspace.workspaceFolders) {
            if (generation !== this.searchGeneration) {
                return [];
            }

            const folderResults = await this.searchFolder(folder, normalizedQuery, generation);

            results.push(...folderResults);
        }

        if (generation !== this.searchGeneration) {
            return [];
        }

        this.searchResults = results;
        this.cacheResults(cacheKey, results);

        // Do not compete with the first interactive ripgrep search. Once that
        // result is visible, restore the persisted index in the background so
        // every new query after it can use the in-memory postings.
        void this.ensureCacheLoaded();

        return this.searchResults;
    }

    public cancelSearch(): void {
        this.searchGeneration++;
        this.stopCurrentProcess();
        this.searchResults = [];
    }

    public invalidateCache(): void {
        this.resultCache.clear();
        this.cancelSearch();
    }

    public invalidateIndex(): void {
        this.invalidateCache();
        this.indexGeneration++;
        this.indexedFiles = [];
        this.trigramIndex.clear();
        this.indexReady = false;
        this.indexComplete = false;
        this.cacheLoadPromise = Promise.resolve(0);

        const cacheUri = this.getIndexCacheUri();

        if (cacheUri) {
            this.staleCacheDeletePromise = this.staleCacheDeletePromise
                .then(() => vscode.workspace.fs.delete(cacheUri))
                .then(undefined, () => {});
        }
    }

    public markIndexStale(): void {
        this.invalidateCache();
        this.indexGeneration++;
        this.indexReady = false;
        this.cacheLoadPromise = Promise.resolve(0);

        const cacheUri = this.getIndexCacheUri();

        if (cacheUri) {
            this.staleCacheDeletePromise = this.staleCacheDeletePromise
                .then(() => vscode.workspace.fs.delete(cacheUri))
                .then(undefined, () => {});
        }
    }

    public async refreshFiles(uris: vscode.Uri[]): Promise<void> {
        if (uris.length === 0) {
            return this.refresh();
        }

        if (!this.storageUri || this.maxFileSizeBytes <= 0 || this.maxIndexBytes <= 0) {
            return;
        }

        if (this.refreshPromise) {
            await this.refreshPromise;
        }

        await this.staleCacheDeletePromise;

        const generation = ++this.indexGeneration;

        this.refreshPromise = this.updateAndPersistFiles(uris, generation).finally(() => {
            this.refreshPromise = undefined;
        });

        return this.refreshPromise;
    }

    private cacheResults(key: string, results: TextMatchItem[]): void {
        this.resultCache.set(key, results);

        while (this.resultCache.size > TextSearchProvider.MAX_CACHE_ENTRIES) {
            const oldestKey = this.resultCache.keys().next().value as string | undefined;

            if (!oldestKey) {
                break;
            }

            this.resultCache.delete(oldestKey);
        }
    }

    private stopCurrentProcess(): void {
        if (this.currentProcess) {
            this.currentProcess.kill();
            this.currentProcess = undefined;
        }
    }

    public async loadCache(reportProgress?: (message: string, increment?: number) => void): Promise<number> {
        reportProgress?.('Loading persistent text index...', 0);
        const count = await this.ensureCacheLoaded();

        reportProgress?.(
            count > 0 ? `Loaded text index (${count} files)` : 'No persistent text index found',
            100
        );

        return count;
    }

    private async ensureCacheLoaded(): Promise<number> {
        if (!this.storageUri || this.maxIndexBytes <= 0) {
            return 0;
        }

        if (!this.cacheLoadPromise) {
            const generation = this.indexGeneration;

            this.cacheLoadPromise = this.loadIndexCache(generation);
        }

        return this.cacheLoadPromise;
    }

    private async loadIndexCache(generation: number): Promise<number> {
        const cacheUri = this.getIndexCacheUri();

        if (!cacheUri) {
            return 0;
        }

        try {
            const bytes = await vscode.workspace.fs.readFile(cacheUri);
            const maxPersistedBytes = Math.max(this.maxIndexBytes * 4, 4 * 1024 * 1024);

            if (bytes.byteLength > maxPersistedBytes) {
                return 0;
            }

            const records = Buffer.from(bytes).toString('utf8').split('\n').filter(Boolean);

            if (records.length === 0) {
                return 0;
            }

            const header = JSON.parse(records[0]) as PersistedTextIndexHeader;

            if (header.version !== TextSearchProvider.INDEX_VERSION ||
                header.workspaceSignature !== this.getWorkspaceSignature()) {
                return 0;
            }

            const persistedFiles = records.slice(1).map(record => JSON.parse(record) as PersistedTextIndexFile);
            const { files, trigrams } = await buildRuntimeIndex(persistedFiles);

            if (generation !== this.indexGeneration) {
                return 0;
            }

            this.indexedFiles = files;
            this.trigramIndex = trigrams;
            this.indexReady = true;
            this.indexComplete = header.complete;

            return files.length;
        } catch (error) {
            Logger.debug(`No persistent text index loaded: ${error}`);

            return 0;
        }
    }

    private async buildAndPersistIndex(generation: number): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        const persistedFiles: PersistedTextIndexFile[] = [];
        let indexedBytes = 0;
        let complete = true;

        for (const folder of workspaceFolders) {
            const excludePattern = ExclusionPatterns.getExclusionGlob(folder);
            const uris = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, '**/*'),
                excludePattern
            );

            uris.sort((left, right) => left.fsPath.localeCompare(right.fsPath));

            for (let index = 0; index < uris.length; index++) {
                if (generation !== this.indexGeneration) {
                    return;
                }

                const uri = uris[index];

                try {
                    const stat = await vscode.workspace.fs.stat(uri);

                    if (stat.type !== vscode.FileType.File || stat.size > this.maxFileSizeBytes) {
                        continue;
                    }

                    if (indexedBytes + stat.size > this.maxIndexBytes) {
                        complete = false;
                        continue;
                    }

                    const bytes = await vscode.workspace.fs.readFile(uri);

                    if (isBinaryContent(bytes)) {
                        continue;
                    }

                    indexedBytes += bytes.byteLength;
                    persistedFiles.push({
                        uri: uri.toString(),
                        relativePath: vscode.workspace.asRelativePath(uri),
                        content: Buffer.from(bytes).toString('utf8')
                    });
                } catch (error) {
                    Logger.debug(`Skipping text index file ${uri.fsPath}: ${error}`);
                }

                if (index > 0 && index % 25 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
        }

        if (generation !== this.indexGeneration) {
            return;
        }

        const { files, trigrams } = await buildRuntimeIndex(persistedFiles);

        if (generation !== this.indexGeneration) {
            return;
        }

        this.indexedFiles = files;
        this.trigramIndex = trigrams;
        this.indexReady = true;
        this.indexComplete = complete;
        this.resultCache.clear();
        await this.persistIndex(persistedFiles, complete);

        console.log(
            `Persistent text index ready: ${files.length} files, ${trigrams.size} trigrams, ` +
            `${indexedBytes} bytes${complete ? '' : ' (capacity-limited; ripgrep fallback active)'}`
        );
    }

    private async updateAndPersistFiles(uris: vscode.Uri[], generation: number): Promise<void> {
        if (this.indexedFiles.length === 0 || !this.indexComplete) {
            await this.buildAndPersistIndex(generation);

            return;
        }

        const changedUris = new Set(uris.map(uri => uri.toString()));
        const persistedFiles: PersistedTextIndexFile[] = this.indexedFiles
            .filter(file => !changedUris.has(file.uri))
            .map(file => ({
                uri: file.uri,
                relativePath: file.relativePath,
                content: file.content
            }));
        let indexedBytes = persistedFiles.reduce((total, file) => total + Buffer.byteLength(file.content, 'utf8'), 0);
        let complete = true;

        for (const uri of uris) {
            if (generation !== this.indexGeneration) {
                return;
            }

            if (!isWorkspaceFile(uri) || ExclusionPatterns.shouldExclude(uri)) {
                continue;
            }

            try {
                const stat = await vscode.workspace.fs.stat(uri);

                if (stat.type !== vscode.FileType.File || stat.size > this.maxFileSizeBytes) {
                    continue;
                }

                const bytes = await vscode.workspace.fs.readFile(uri);

                if (isBinaryContent(bytes)) {
                    continue;
                }

                if (indexedBytes + bytes.byteLength > this.maxIndexBytes) {
                    complete = false;
                    continue;
                }

                indexedBytes += bytes.byteLength;
                persistedFiles.push({
                    uri: uri.toString(),
                    relativePath: vscode.workspace.asRelativePath(uri),
                    content: Buffer.from(bytes).toString('utf8')
                });
            } catch (error) {
                Logger.debug(`Removing unavailable text index file ${uri.fsPath}: ${error}`);
            }
        }

        const { files, trigrams } = await buildRuntimeIndex(persistedFiles);

        if (generation !== this.indexGeneration) {
            return;
        }

        this.indexedFiles = files;
        this.trigramIndex = trigrams;
        this.indexReady = true;
        this.indexComplete = complete;
        this.resultCache.clear();
        await this.persistIndex(persistedFiles, complete);

        console.log(`Incrementally updated text index for ${changedUris.size} workspace files`);
    }

    private async persistIndex(files: PersistedTextIndexFile[], complete: boolean): Promise<void> {
        const cacheUri = this.getIndexCacheUri();

        if (!cacheUri || !this.storageUri) {
            return;
        }

        const header: PersistedTextIndexHeader = {
            version: TextSearchProvider.INDEX_VERSION,
            workspaceSignature: this.getWorkspaceSignature(),
            complete
        };
        const body = [JSON.stringify(header), ...files.map(file => JSON.stringify(file)), ''].join('\n');
        const temporaryUri = vscode.Uri.joinPath(this.storageUri, `${TextSearchProvider.INDEX_FILE_NAME}.tmp`);

        await vscode.workspace.fs.createDirectory(this.storageUri);
        await vscode.workspace.fs.writeFile(temporaryUri, Buffer.from(body, 'utf8'));
        await vscode.workspace.fs.rename(temporaryUri, cacheUri, { overwrite: true });
    }

    private searchIndex(query: string, generation: number): TextMatchItem[] {
        const plans = buildTextSearchQueryPlans(query);
        const results = new Map<string, TextMatchItem>();

        for (const plan of plans) {
            const candidateIds = this.getCandidateFileIds(query, plan);

            for (const fileId of candidateIds) {
                if (generation !== this.searchGeneration) {
                    return [];
                }

                for (const item of this.findIndexedMatches(this.indexedFiles[fileId], query, plan)) {
                    results.set(item.id, item);
                }
            }
        }

        return [...results.values()];
    }

    private getCandidateFileIds(query: string, plan: TextSearchQueryPlan): number[] {
        const mode = plan.useRegex ? 'compact' : 'raw';
        const candidateText = plan.useRegex ? compactIndexText(query) : query.toLowerCase();
        const grams = getUniqueTrigrams(candidateText);

        if (grams.length === 0) {
            return this.indexedFiles.map((_, index) => index);
        }

        const postings = grams.map(gram => this.trigramIndex.get(`${mode}:${gram}`));

        if (postings.some(posting => !posting)) {
            return [];
        }

        const sortedPostings = (postings as number[][]).sort((left, right) => left.length - right.length);

        return sortedPostings[0].filter(fileId =>
            sortedPostings.slice(1).every(posting => containsSortedNumber(posting, fileId))
        );
    }

    private findIndexedMatches(file: IndexedTextFile, query: string, plan: TextSearchQueryPlan): TextMatchItem[] {
        const results: TextMatchItem[] = [];
        const literalQuery = query.toLowerCase();
        const regex = plan.useRegex ? new RegExp(plan.pattern, 'i') : undefined;

        for (let lineIndex = 0; lineIndex < file.lineStarts.length && results.length < 3; lineIndex++) {
            const lineStart = file.lineStarts[lineIndex];
            const nextLineStart = file.lineStarts[lineIndex + 1] ?? file.content.length;
            const lineEnd = trimLineEnding(file.content, lineStart, nextLineStart);
            const lineText = file.content.slice(lineStart, lineEnd);
            const match = regex?.exec(lineText);
            const matchStart = match ? match.index : file.lowerContent.slice(lineStart, lineEnd).indexOf(literalQuery);

            if (matchStart < 0) {
                continue;
            }

            const matchText = match?.[0] || lineText.slice(matchStart, matchStart + query.length);
            const matchEnd = matchStart + matchText.length;

            results.push(this.createIndexedSearchItem(file, lineText, lineIndex, matchStart, matchEnd, matchText));
        }

        return results;
    }

    private createIndexedSearchItem(
        file: IndexedTextFile,
        lineText: string,
        lineIndex: number,
        matchStart: number,
        matchEnd: number,
        matchText: string
    ): TextMatchItem {
        const range = new vscode.Range(lineIndex, matchStart, lineIndex, matchEnd);
        const matchPriority = getTextMatchPriority(lineText, matchStart, matchEnd);

        return {
            id: `text-match:${file.uri}:${lineIndex}:${matchStart}`,
            type: SearchItemType.TextMatch,
            label: lineText.trim(),
            description: file.relativePath,
            detail: `Line ${lineIndex + 1}`,
            uri: file.parsedUri,
            range,
            lineText,
            matchText,
            score: 1.0,
            action: async () => {
                const document = await vscode.workspace.openTextDocument(file.parsedUri);
                const editor = await vscode.window.showTextDocument(document);

                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                editor.selection = new vscode.Selection(range.start, range.end);
            },
            iconPath: new vscode.ThemeIcon('file-text'),
            priority: 30 + matchPriority
        };
    }

    private getIndexCacheUri(): vscode.Uri | undefined {
        return this.storageUri && vscode.Uri.joinPath(this.storageUri, TextSearchProvider.INDEX_FILE_NAME);
    }

    private getWorkspaceSignature(): string {
        return (vscode.workspace.workspaceFolders || [])
            .map(folder => folder.uri.toString())
            .sort()
            .join('\n');
    }

    private async searchFolder(folder: vscode.WorkspaceFolder, query: string, generation: number): Promise<TextMatchItem[]> {
        const plans = buildTextSearchQueryPlans(query);
        const dedupedResults = new Map<string, TextMatchItem>();

        for (const plan of plans) {
            if (generation !== this.searchGeneration) {
                return [];
            }

            const planResults = await this.runTextSearch(folder, query, plan, generation);

            for (const item of planResults) {
                dedupedResults.set(item.id, item);
            }
        }

        return [...dedupedResults.values()];
    }

    private getRgCommand(): string {
        for (const candidate of getBundledRgCandidates(vscode.env.appRoot, process.platform, process.arch)) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        return 'rg';
    }

    private buildRgArgs(folder: vscode.WorkspaceFolder, plan: TextSearchQueryPlan): string[] {
        const args = [
            '--json',
            '--ignore-case',
            '--line-number',
            '--column',
            '--max-count',
            '3',
            plan.pattern,
            '.'
        ];

        if (!plan.useRegex) {
            args.splice(1, 0, '--fixed-strings');
        }

        for (const pattern of ExclusionPatterns.getSearchExcludePatterns(folder)) {
            args.splice(args.length - 2, 0, '--glob', `!${pattern}`);
        }

        return args;
    }

    private async runTextSearch(
        folder: vscode.WorkspaceFolder,
        query: string,
        plan: TextSearchQueryPlan,
        generation: number
    ): Promise<TextMatchItem[]> {
        return new Promise(resolve => {
            const results: TextMatchItem[] = [];
            const args = this.buildRgArgs(folder, plan);
            const child = spawn(this.getRgCommand(), args, {
                cwd: folder.uri.fsPath,
                windowsHide: true
            });

            this.currentProcess = child;

            let buffer = '';

            child.stdout.setEncoding('utf8');
            child.stdout.on('data', chunk => {
                if (generation !== this.searchGeneration) {
                    return;
                }

                buffer += chunk;
                buffer = this.processRgOutput(buffer, folder, query, results);
            });

            child.stderr.setEncoding('utf8');
            child.stderr.on('data', chunk => {
                Logger.debug(`ripgrep text search stderr: ${chunk}`);
            });

            child.on('error', error => {
                Logger.debug(`ripgrep text search failed: ${error}`);
                resolve(results);
            });

            child.on('close', () => {
                if (this.currentProcess === child) {
                    this.currentProcess = undefined;
                }

                if (generation === this.searchGeneration && buffer.trim()) {
                    this.processRgOutput(`${buffer}\n`, folder, query, results);
                }

                resolve(results);
            });
        });
    }

    private processRgOutput(
        buffer: string,
        folder: vscode.WorkspaceFolder,
        query: string,
        results: TextMatchItem[]
    ): string {
        const lines = buffer.split('\n');
        const remainder = lines.pop() || '';

        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }

            try {
                const event = JSON.parse(line) as RgMatch;

                if (event.type !== 'match' || !event.data) {
                    continue;
                }

                const item = this.createSearchItem(folder, event.data, query);

                if (item) {
                    results.push(item);
                }
            } catch (error) {
                Logger.debug(`Error parsing ripgrep text search output: ${error}`);
            }
        }

        return remainder;
    }

    private createSearchItem(folder: vscode.WorkspaceFolder, data: NonNullable<RgMatch['data']>, query: string): TextMatchItem | undefined {
        const relativePath = data.path?.text;
        const lineText = data.lines?.text;
        const lineNumber = data.line_number;
        const submatch = data.submatches?.[0];

        if (!relativePath || !lineText || !lineNumber || !submatch) {
            return undefined;
        }

        const uri = vscode.Uri.joinPath(folder.uri, relativePath);

        // ripgrep already received the complete exclusion glob set once for
        // this search. Re-running every exclusion rule for every match is both
        // redundant and expensive in the extension host.
        if (!isWorkspaceFile(uri)) {
            return undefined;
        }

        const start = new vscode.Position(lineNumber - 1, submatch.start);
        const end = new vscode.Position(lineNumber - 1, submatch.end);
        const range = new vscode.Range(start, end);
        const matchPriority = getTextMatchPriority(lineText, submatch.start, submatch.end);

        return {
            id: `text-match:${uri.toString()}:${range.start.line}:${range.start.character}`,
            type: SearchItemType.TextMatch,
            label: lineText.trim(),
            description: vscode.workspace.asRelativePath(uri),
            detail: `Line ${lineNumber}`,
            uri,
            range,
            lineText,
            matchText: submatch.match?.text || query,
            score: 1.0,
            action: async () => {
                try {
                    const document = await vscode.workspace.openTextDocument(uri);
                    const editor = await vscode.window.showTextDocument(document);

                    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                    editor.selection = new vscode.Selection(range.start, range.end);
                } catch (error) {
                    Logger.debug(`Error opening text match: ${error}`);
                }
            },
            iconPath: new vscode.ThemeIcon('file-text'),
            priority: 30 + matchPriority
        };
    }
}

async function buildRuntimeIndex(persistedFiles: PersistedTextIndexFile[]): Promise<{
    files: IndexedTextFile[];
    trigrams: Map<string, number[]>;
}> {
    const files: IndexedTextFile[] = [];
    const trigrams = new Map<string, number[]>();

    for (let index = 0; index < persistedFiles.length; index++) {
        const persistedFile = persistedFiles[index];
        const lowerContent = persistedFile.content.toLowerCase();
        const file: IndexedTextFile = {
            ...persistedFile,
            parsedUri: vscode.Uri.parse(persistedFile.uri),
            lowerContent,
            lineStarts: getLineStarts(persistedFile.content)
        };
        const fileId = files.length;

        files.push(file);
        addFileTrigrams(trigrams, 'raw', lowerContent, fileId);
        addFileTrigrams(trigrams, 'compact', compactIndexText(lowerContent), fileId);

        if (index > 0 && index % 25 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    return { files, trigrams };
}

function addFileTrigrams(index: Map<string, number[]>, mode: string, text: string, fileId: number): void {
    for (const gram of getUniqueTrigrams(text)) {
        const key = `${mode}:${gram}`;
        const posting = index.get(key);

        if (posting) {
            posting.push(fileId);
        } else {
            index.set(key, [fileId]);
        }
    }
}

function getUniqueTrigrams(text: string): string[] {
    if (text.length < 3) {
        return [];
    }

    const grams = new Set<string>();

    for (let index = 0; index <= text.length - 3; index++) {
        grams.add(text.slice(index, index + 3));
    }

    return [...grams];
}

function compactIndexText(text: string): string {
    return text.toLowerCase().replace(/[\s_-]+/g, '');
}

function containsSortedNumber(values: number[], target: number): boolean {
    let low = 0;
    let high = values.length - 1;

    while (low <= high) {
        const middle = (low + high) >> 1;
        const value = values[middle];

        if (value === target) {
            return true;
        }

        if (value < target) {
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }

    return false;
}

function getLineStarts(content: string): number[] {
    const starts = [0];

    for (let index = 0; index < content.length; index++) {
        if (content.charCodeAt(index) === 10 && index + 1 < content.length) {
            starts.push(index + 1);
        }
    }

    return starts;
}

function trimLineEnding(content: string, start: number, end: number): number {
    let trimmedEnd = end;

    if (trimmedEnd > start && content.charCodeAt(trimmedEnd - 1) === 10) {
        trimmedEnd--;
    }

    if (trimmedEnd > start && content.charCodeAt(trimmedEnd - 1) === 13) {
        trimmedEnd--;
    }

    return trimmedEnd;
}

function isBinaryContent(bytes: Uint8Array): boolean {
    const sampleLength = Math.min(bytes.byteLength, 4096);

    for (let index = 0; index < sampleLength; index++) {
        if (bytes[index] === 0) {
            return true;
        }
    }

    return false;
}

export function getTextMatchPriority(lineText: string, start: number, end: number): number {
    const before = start > 0 ? lineText[start - 1] : '';
    const first = lineText[start] || '';
    const last = end > start ? lineText[end - 1] : '';
    const after = end < lineText.length ? lineText[end] : '';
    const startsCamelSegment = /[a-z0-9]/.test(before) && /[A-Z]/.test(first);
    const endsCamelSegment = /[a-z0-9]/.test(last) && /[A-Z]/.test(after);
    const startsToken = !before || /[^A-Za-z0-9_$]/.test(before) || startsCamelSegment;
    const endsToken = !after || /[^A-Za-z0-9_$]/.test(after) || endsCamelSegment;

    if (startsCamelSegment && endsToken) {
        return 40;
    }

    return startsToken && endsToken ? 25 : 0;
}

export function buildTextSearchQueryPlans(query: string): TextSearchQueryPlan[] {
    const normalizedQuery = query.trim();

    if (!normalizedQuery) {
        return [];
    }

    const plans: TextSearchQueryPlan[] = [{
        pattern: normalizedQuery,
        useRegex: false
    }];
    const flexiblePattern = buildFlexibleSeparatorPattern(normalizedQuery);

    if (flexiblePattern && flexiblePattern !== normalizedQuery) {
        plans.push({
            pattern: flexiblePattern,
            useRegex: true
        });
    }

    return plans;
}

function buildFlexibleSeparatorPattern(query: string): string | undefined {
    if (!/\s/.test(query)) {
        return undefined;
    }

    const parts = query
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(escapeRegex);

    if (parts.length < 2) {
        return undefined;
    }

    return parts.join('[\\s_-]*');
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getBundledRgCandidates(appRoot: string, platform: NodeJS.Platform, arch: string): string[] {
    const resourceRoot = path.dirname(appRoot);
    const platformDir = getRgPlatformDir(platform, arch);

    return [
        path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', platform === 'win32' ? 'rg.exe' : 'rg'),
        path.join(appRoot, 'node_modules', '@vscode', 'ripgrep-universal', 'bin', platformDir, RG_EXECUTABLE_NAME),
        path.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', platformDir, RG_EXECUTABLE_NAME),
        path.join(resourceRoot, RG_EXECUTABLE_NAME)
    ];
}

function getRgPlatformDir(platform: NodeJS.Platform, arch: string): string {
    switch (platform) {
        case 'darwin':
            return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';

        case 'win32':
            if (arch === 'arm64') {
                return 'win32-arm64';
            }

            return arch === 'x64' ? 'win32-x64' : 'win32-ia32';

        case 'linux':
            if (arch === 'arm64') {
                return 'linux-arm64';
            }

            if (arch === 'arm') {
                return 'linux-armhf';
            }

            return 'linux-x64';

        default:
            return `${platform}-${arch}`;
    }
}
