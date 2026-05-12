import * as vscode from 'vscode';
import { SearchItemType, SearchProvider, TextMatchItem } from '../core/types';
import { getConfiguration } from '../utils/config';
import { ExclusionPatterns } from '../utils/exclusions';
import Logger from '../utils/logging';
import { isWorkspaceFile } from '../utils/workspace';

interface IndexedTextLine {
    uri: vscode.Uri;
    lineNumber: number;
    text: string;
    label: string;
    lowerText: string;
}

/**
 * Provides text search results from an in-memory line index built from workspace files.
 */
export class TextSearchProvider implements SearchProvider {
    private indexedLines: IndexedTextLine[] = [];
    private searchResults: TextMatchItem[] = [];
    private isRefreshing: boolean = false;
    private indexSizeBytes: number = 0;

    /**
     * Text search results are query-specific, so there are no static items for the shared index.
     */
    public async getItems(): Promise<TextMatchItem[]> {
        if (this.indexedLines.length === 0 && !this.isRefreshing) {
            await this.refresh();
        }

        return [];
    }

    /**
     * Build the text index once from files in the current workspace.
     */
    public async refresh(): Promise<void> {
        if (this.isRefreshing) {
            return;
        }

        this.isRefreshing = true;
        this.indexedLines = [];
        this.searchResults = [];
        this.indexSizeBytes = 0;

        try {
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                return;
            }

            const config = getConfiguration();
            const excludePattern = ExclusionPatterns.getExclusionGlob();
            const startTime = performance.now();

            for (const folder of vscode.workspace.workspaceFolders) {
                const files = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(folder, '**/*'),
                    excludePattern
                );

                for (const uri of files) {
                    if (this.indexSizeBytes >= config.performance.maxTextIndexBytes) {
                        break;
                    }

                    await this.indexFile(uri, config.performance.maxTextFileSizeBytes, config.performance.maxTextIndexBytes);
                }
            }

            const endTime = performance.now();

            Logger.debug(`Indexed ${this.indexedLines.length} text lines (${this.indexSizeBytes} bytes) in ${endTime - startTime}ms`);
        } catch (error) {
            Logger.debug(`Error refreshing text index: ${error}`);
        } finally {
            this.isRefreshing = false;
        }
    }

    /**
     * Search the in-memory text index.
     */
    public async search(query: string): Promise<TextMatchItem[]> {
        const normalizedQuery = query.trim().toLowerCase();

        if (!normalizedQuery) {
            this.searchResults = [];

            return this.searchResults;
        }

        if (this.indexedLines.length === 0 && !this.isRefreshing) {
            await this.refresh();
        }

        const config = getConfiguration();
        const maxResults = config.performance.maxResults;
        const maxTextResultsPerFile = config.performance.maxTextResults;
        const perFileCounts = new Map<string, number>();
        const results: TextMatchItem[] = [];

        for (const indexedLine of this.indexedLines) {
            if (results.length >= maxResults) {
                break;
            }

            const matchIndex = indexedLine.lowerText.indexOf(normalizedQuery);

            if (matchIndex === -1) {
                continue;
            }

            const uriKey = indexedLine.uri.toString();
            const fileCount = perFileCounts.get(uriKey) || 0;

            if (fileCount >= maxTextResultsPerFile) {
                continue;
            }

            perFileCounts.set(uriKey, fileCount + 1);
            results.push(this.createSearchItem(indexedLine, matchIndex, query));
        }

        this.searchResults = results;

        return this.searchResults;
    }

    /**
     * Clear query results. The built text index is kept until refresh rebuilds it.
     */
    public cancelSearch(): void {
        this.searchResults = [];
    }

    private async indexFile(uri: vscode.Uri, maxFileSizeBytes: number, maxIndexBytes: number): Promise<void> {
        try {
            if (!isWorkspaceFile(uri) || ExclusionPatterns.shouldExclude(uri)) {
                return;
            }

            const stat = await vscode.workspace.fs.stat(uri);

            if (stat.size > maxFileSizeBytes) {
                return;
            }

            const document = await vscode.workspace.openTextDocument(uri);
            const lines = document.getText().split('\n');

            for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
                const text = lines[lineNumber];
                const label = text.trim();

                if (!label) {
                    continue;
                }

                const lineSizeBytes = Buffer.byteLength(text, 'utf8') + indexedLineOverheadBytes(uri);

                if (this.indexSizeBytes + lineSizeBytes > maxIndexBytes) {
                    return;
                }

                this.indexedLines.push({
                    uri,
                    lineNumber,
                    text,
                    label,
                    lowerText: text.toLowerCase()
                });
                this.indexSizeBytes += lineSizeBytes;
            }
        } catch (error) {
            Logger.debug(`Error indexing text file ${uri.toString()}: ${error}`);
        }
    }

    private createSearchItem(indexedLine: IndexedTextLine, matchIndex: number, query: string): TextMatchItem {
        const startPos = new vscode.Position(indexedLine.lineNumber, matchIndex);
        const endPos = new vscode.Position(indexedLine.lineNumber, matchIndex + query.trim().length);
        const range = new vscode.Range(startPos, endPos);

        return {
            id: `text-match:${indexedLine.uri.toString()}:${range.start.line}:${range.start.character}`,
            type: SearchItemType.TextMatch,
            label: indexedLine.label,
            description: vscode.workspace.asRelativePath(indexedLine.uri),
            detail: `Line ${range.start.line + 1}`,
            uri: indexedLine.uri,
            range,
            lineText: indexedLine.text,
            matchText: indexedLine.text.substring(matchIndex, matchIndex + query.trim().length),
            score: 1.0,
            action: async () => {
                try {
                    const document = await vscode.workspace.openTextDocument(indexedLine.uri);
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

function indexedLineOverheadBytes(uri: vscode.Uri): number {
    return Buffer.byteLength(uri.toString(), 'utf8') + 64;
}
