import * as vscode from 'vscode';
import { FileSearchItem, SearchItemType, SearchProvider } from '../core/types';
import { ExclusionPatterns } from '../utils/exclusions';

/**
 * Provides file search items from the workspace
 */
export class FileSearchProvider implements SearchProvider {
    private fileItems: FileSearchItem[] = [];
    private indexedDirectories = new Set<string>();
    private refreshPromise: Promise<void> | undefined;
    private isPartial: boolean = false;

    /**
     * Get all indexed file items
     */
    public async getItems(): Promise<FileSearchItem[]> {
        if (this.refreshPromise) {
            await this.refreshPromise;
        }

        if (this.fileItems.length === 0 || this.isPartial) {
            await this.refresh();
        }

        return this.fileItems;
    }

    public async warmUp(maxFiles: number): Promise<FileSearchItem[]> {
        if (this.refreshPromise) {
            await this.refreshPromise;
        }

        if (this.fileItems.length === 0) {
            await this.refresh(maxFiles);
        }

        return this.fileItems;
    }

    /**
     * Refresh the file index
     */
    public async refresh(maxFiles?: number): Promise<void> {
        if (this.refreshPromise) {
            await this.refreshPromise;

            return;
        }

        let resolveRefresh!: () => void;

        this.refreshPromise = new Promise(resolve => {
            resolveRefresh = resolve;
        });

        console.log('Refreshing file index...');
        const startTime = performance.now();

        this.fileItems = [];
        this.indexedDirectories.clear();
        this.isPartial = Boolean(maxFiles);

        try {
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                console.log('No workspace folders found');

                return;
            }

            // Process each workspace folder
            for (const folder of vscode.workspace.workspaceFolders) {
                console.log(`Indexing files in workspace folder: ${folder.name}`);
                const excludePattern = ExclusionPatterns.getExclusionGlob(folder);

                // Find all files in the workspace folder
                const files = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(folder, '**/*'),
                    excludePattern,
                    maxFiles
                );

                console.log(`Found ${files.length} files in ${folder.name}`);

                // Process files in batches to avoid UI freezes
                const batchSize = 500;
                const shouldRunDeepExclude = files.length <= 5000;

                for (let i = 0; i < files.length; i += batchSize) {
                    const batch = files.slice(i, i + batchSize);

                    this.processFileBatch(batch, folder, shouldRunDeepExclude);

                    // Log progress for large workspaces
                    if (i > 0 && i % 5000 === 0) {
                        console.log(`Processed ${i} files...`);
                    }

                    // Keep the extension host responsive while indexing large workspaces.
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
        } catch (error) {
            console.error('Error refreshing file index:', error);
        } finally {
            const endTime = performance.now();

            console.log(`Indexed ${this.fileItems.length} files in ${endTime - startTime}ms`);

            resolveRefresh();
            this.refreshPromise = undefined;
        }
    }

    /**
     * Process a batch of files
     */
    private processFileBatch(files: vscode.Uri[], workspaceFolder: vscode.WorkspaceFolder, shouldRunDeepExclude: boolean): void {
        for (const uri of files) {
            try {
                if (shouldRunDeepExclude && ExclusionPatterns.shouldExclude(uri)) {
                    continue;
                }

                // Create a relative path for display
                let relativePath = uri.fsPath;
                const workspacePath = workspaceFolder.uri.fsPath;

                if (relativePath.startsWith(workspacePath)) {
                    relativePath = relativePath.substring(workspacePath.length);
                    // Remove leading slash or backslash
                    if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
                        relativePath = relativePath.substring(1);
                    }
                }

                // Get file name
                const fileName = uri.fsPath.split(/[\/\\]/).pop() || '';

                this.addParentDirectories(workspaceFolder, relativePath);

                // Add file item
                this.fileItems.push({
                    id: `file:${uri.toString()}`,
                    label: fileName,
                    description: relativePath,
                    detail: uri.fsPath,
                    type: SearchItemType.File,
                    uri: uri,
                    iconPath: this.getFileIcon(fileName),
                    action: async () => {
                        // Open the file in editor
                        await vscode.window.showTextDocument(uri);
                    }
                });
            } catch (error) {
                console.error(`Error processing file ${uri.fsPath}:`, error);
            }
        }
    }

    private addParentDirectories(workspaceFolder: vscode.WorkspaceFolder, relativeFilePath: string): void {
        const parts = relativeFilePath.split(/[\/\\]/).filter(Boolean);

        for (let depth = 1; depth < parts.length; depth++) {
            const directoryPath = parts.slice(0, depth).join('/');
            const uri = vscode.Uri.joinPath(workspaceFolder.uri, ...parts.slice(0, depth));
            const key = uri.toString();

            if (this.indexedDirectories.has(key)) {
                continue;
            }

            this.indexedDirectories.add(key);
            this.fileItems.push({
                id: `directory:${key}`,
                label: parts[depth - 1],
                description: directoryPath,
                detail: uri.fsPath,
                type: SearchItemType.File,
                uri,
                isDirectory: true,
                priority: 80,
                iconPath: new vscode.ThemeIcon('folder'),
                action: async () => {
                    await vscode.commands.executeCommand('revealInExplorer', uri);
                }
            });
        }
    }

    /**
     * Get an icon for a file based on extension
     */
    private getFileIcon(fileName: string): vscode.ThemeIcon {
        const extension = fileName.split('.').pop()?.toLowerCase();

        // Return appropriate icon based on file extension
        switch (extension) {
            case 'js':

            case 'jsx':

            case 'ts':

            case 'tsx':
                return new vscode.ThemeIcon('file-code');

            case 'json':
                return new vscode.ThemeIcon('file-json');

            case 'md':
                return new vscode.ThemeIcon('markdown');

            case 'html':

            case 'htm':
                return new vscode.ThemeIcon('html');

            case 'css':

            case 'scss':

            case 'sass':

            case 'less':
                return new vscode.ThemeIcon('file-css');

            case 'xml':
                return new vscode.ThemeIcon('file-xml');

            case 'py':
                return new vscode.ThemeIcon('python');

            case 'cs':
                return new vscode.ThemeIcon('c-sharp');

            case 'java':
                return new vscode.ThemeIcon('java');

            case 'c':

            case 'cpp':

            case 'h':

            case 'hpp':
                return new vscode.ThemeIcon('file-code');

            case 'php':
                return new vscode.ThemeIcon('file-code');

            case 'go':
                return new vscode.ThemeIcon('file-code');

            case 'rb':
                return new vscode.ThemeIcon('ruby');

            case 'rust':

            case 'rs':
                return new vscode.ThemeIcon('file-code');

            case 'sh':

            case 'bash':
                return new vscode.ThemeIcon('terminal');

            case 'yaml':

            case 'yml':
                return new vscode.ThemeIcon('file-yaml');

            case 'toml':
                return new vscode.ThemeIcon('file-text');

            case 'sql':
                return new vscode.ThemeIcon('file-text');

            case 'ps1':
                return new vscode.ThemeIcon('terminal-powershell');

            case 'git':

            case 'gitignore':

            case 'gitattributes':
                return new vscode.ThemeIcon('git');

            default:
                return new vscode.ThemeIcon('file');
        }
    }
}
