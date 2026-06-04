import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SearchItemType, SearchProvider, TextMatchItem } from '../core/types';
import { getConfiguration } from '../utils/config';
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

const RG_EXECUTABLE_NAME = process.platform === 'win32' ? 'rg.exe' : 'rg';

/**
 * Provides full-text results through ripgrep on demand.
 *
 * Search Everywhere should not own a persistent text index. Text is only a
 * fallback source, so we stream a bounded set of ripgrep matches when needed.
 */
export class TextSearchProvider implements SearchProvider {
    private searchResults: TextMatchItem[] = [];
    private currentProcess: ReturnType<typeof spawn> | undefined;

    public async getItems(): Promise<TextMatchItem[]> {
        return [];
    }

    public async refresh(): Promise<void> {
        this.searchResults = [];
    }

    public async search(query: string): Promise<TextMatchItem[]> {
        const normalizedQuery = query.trim();

        this.cancelSearch();

        if (!normalizedQuery || !vscode.workspace.workspaceFolders?.length) {
            this.searchResults = [];

            return this.searchResults;
        }

        const config = getConfiguration();
        const maxResults = Math.min(config.performance.maxResults, config.performance.maxTextResults);
        const results: TextMatchItem[] = [];

        for (const folder of vscode.workspace.workspaceFolders) {
            if (results.length >= maxResults) {
                break;
            }

            const folderResults = await this.searchFolder(folder, normalizedQuery, maxResults - results.length);

            results.push(...folderResults);
        }

        this.searchResults = results;

        return this.searchResults;
    }

    public cancelSearch(): void {
        if (this.currentProcess) {
            this.currentProcess.kill();
            this.currentProcess = undefined;
        }

        this.searchResults = [];
    }

    public async loadCache(reportProgress?: (message: string, increment?: number) => void): Promise<number> {
        reportProgress?.('Text search uses ripgrep on demand', 100);

        return 0;
    }

    private async searchFolder(folder: vscode.WorkspaceFolder, query: string, limit: number): Promise<TextMatchItem[]> {
        const plans = buildTextSearchQueryPlans(query);
        const dedupedResults = new Map<string, TextMatchItem>();

        for (const plan of plans) {
            if (dedupedResults.size >= limit) {
                break;
            }

            const planResults = await this.runTextSearch(folder, query, plan, limit - dedupedResults.size);

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
        limit: number
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
                buffer += chunk;
                buffer = this.processRgOutput(buffer, folder, query, results, limit);

                if (results.length >= limit) {
                    child.kill();
                }
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

                if (buffer.trim()) {
                    this.processRgOutput(`${buffer}\n`, folder, query, results, limit);
                }

                resolve(results);
            });
        });
    }

    private processRgOutput(
        buffer: string,
        folder: vscode.WorkspaceFolder,
        query: string,
        results: TextMatchItem[],
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

        if (!isWorkspaceFile(uri) || ExclusionPatterns.shouldExclude(uri)) {
            return undefined;
        }

        const start = new vscode.Position(lineNumber - 1, submatch.start);
        const end = new vscode.Position(lineNumber - 1, submatch.end);
        const range = new vscode.Range(start, end);

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
            priority: 30
        };
    }
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
