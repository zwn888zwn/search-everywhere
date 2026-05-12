import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConfiguration } from './config';
import Logger from './logging';
import { minimatch } from 'minimatch';
import { isWorkspaceFile } from './workspace';

/**
 * Utility for managing exclusion patterns that are shared across providers
 */
export class ExclusionPatterns {
    private static gitIgnoreCache = new Map<string, string[]>();

    /**
     * Get the default exclusion patterns plus any user-configured ones
     */
    public static getExclusionPatterns(): string[] {
        const defaultPatterns = [
            // Common version control directories
            '**/node_modules/**',
            '**/.git/**',
            '**/.svn/**',
            '**/.hg/**',

            // Build output directories
            '**/bin/**',
            '**/build/**',
            '**/dist/**',
            '**/target/**',
            '**/out/**',

            // Package directories
            '**/packages/**',
            '**/vendor/**',

            // IDE directories
            '**/.idea/**',
            '**/.vs/**',
            '**/.vscode/**',

            // Binary files
            '**/*.pyc',
            '**/*.class',
            '**/*.o',
            '**/*.obj',
            '**/*.exe',
            '**/*.dll',
            '**/*.so',
            '**/*.dylib',

            // Temporary and backup files
            '**/*.tmp',
            '**/*.bak',
            '**/*~',
            '**/.DS_Store',

            // Large data files
            '**/*.zip',
            '**/*.tar',
            '**/*.gz',
            '**/*.rar',
            '**/*.7z',
            '**/*.jar',
            '**/*.war',
            '**/*.ear',
            '**/*.iso',
            '**/*.pdf',
            '**/*.docx',
            '**/*.xlsx',

            // Media files
            '**/*.jpg',
            '**/*.jpeg',
            '**/*.png',
            '**/*.gif',
            '**/*.svg',
            '**/*.ico',
            '**/*.mp3',
            '**/*.mp4',
            '**/*.wav',
            '**/*.avi',

            // Log files
            '**/*.log'
        ];

        // Add any user-configured exclude patterns from settings
        const config = getConfiguration();

        if (config.exclusions && Array.isArray(config.exclusions)) {
            const allPatterns = [...defaultPatterns, ...config.exclusions];

            Logger.debug(`Loaded exclusion patterns - Default: ${defaultPatterns.length}, User: ${config.exclusions.length}, Total: ${allPatterns.length}`);
            if (config.debug && config.exclusions.length > 0) {
                Logger.debug(`User-configured exclusions: ${config.exclusions.join(', ')}`);
            }

            return allPatterns;
        }

        Logger.debug(`Loaded exclusion patterns - Default: ${defaultPatterns.length}, User: 0, Total: ${defaultPatterns.length}`);

        return defaultPatterns;
    }

    /**
     * Get the exclusion pattern string for use with vscode.workspace.findFiles
     */
    public static getExclusionGlob(): string {
        const patterns = this.getExclusionPatterns();
        const glob = `{${patterns.join(',')}}`;

        Logger.debug(`Generated exclusion glob pattern with ${patterns.length} patterns`);

        return glob;
    }

    /**
     * Check if a URI should be excluded based on the current exclusion patterns
     */
    public static shouldExclude(uri: vscode.Uri): boolean {
        // Don't exclude non-file URIs (like symbols)
        if (uri.scheme !== 'file') {
            Logger.debug(`Skipping exclusion check for non-file URI: ${uri.toString()} (scheme: ${uri.scheme})`);

            return false;
        }

        if (!isWorkspaceFile(uri)) {
            Logger.debug(`Excluded non-workspace file: ${uri.toString()}`);

            return true;
        }

        // Get relative path from workspace root
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

        if (!workspaceFolder) {
            Logger.debug(`Excluded file without workspace folder: ${uri.toString()}`);

            return true;
        }

        const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath).split(path.sep).join('/');

        if (this.isIgnoredByGitIgnore(workspaceFolder, relativePath)) {
            Logger.debug(`Excluded by .gitignore: ${relativePath}`);

            return true;
        }

        // Check against each pattern
        const patterns = this.getExclusionPatterns();

        for (const pattern of patterns) {
            const matches = minimatch(relativePath, pattern, {
                dot: true,        // Match dot files
                matchBase: true,  // Match basename if pattern has no slashes
                nocase: true,     // Case insensitive matching
                nocomment: true,  // Don't treat leading # as comments
                nonegate: true,   // Don't treat leading ! as negation
                noglobstar: false // Enable ** matching (default, but being explicit)
            });

            if (matches) {
                Logger.debug(`Excluded: ${relativePath} (matched pattern: ${pattern})`);

                return true;
            }
        }
        Logger.debug(`Included: ${relativePath}`);

        return false;
    }

    private static isIgnoredByGitIgnore(workspaceFolder: vscode.WorkspaceFolder, relativePath: string): boolean {
        const patterns = this.getGitIgnorePatterns(workspaceFolder);
        let ignored = false;

        for (const pattern of patterns) {
            const negated = pattern.startsWith('!');
            const rawPattern = negated ? pattern.substring(1) : pattern;

            if (this.matchesGitIgnorePattern(relativePath, rawPattern)) {
                ignored = !negated;
            }
        }

        return ignored;
    }

    private static getGitIgnorePatterns(workspaceFolder: vscode.WorkspaceFolder): string[] {
        const workspacePath = workspaceFolder.uri.fsPath;
        const cached = this.gitIgnoreCache.get(workspacePath);

        if (cached) {
            return cached;
        }

        const gitIgnorePath = path.join(workspacePath, '.gitignore');

        try {
            const content = fs.readFileSync(gitIgnorePath, 'utf8');
            const patterns = content
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));

            this.gitIgnoreCache.set(workspacePath, patterns);

            return patterns;
        } catch {
            this.gitIgnoreCache.set(workspacePath, []);

            return [];
        }
    }

    private static matchesGitIgnorePattern(relativePath: string, pattern: string): boolean {
        let normalizedPattern = pattern.replace(/\\/g, '/');

        if (!normalizedPattern) {
            return false;
        }

        if (normalizedPattern.startsWith('/')) {
            normalizedPattern = normalizedPattern.substring(1);
        }

        const directoryOnly = normalizedPattern.endsWith('/');

        if (directoryOnly) {
            normalizedPattern = normalizedPattern.slice(0, -1);
        }

        const hasSlash = normalizedPattern.includes('/');
        const candidates = hasSlash
            ? [normalizedPattern, `${normalizedPattern}/**`]
            : [normalizedPattern, `**/${normalizedPattern}`, `**/${normalizedPattern}/**`];

        if (directoryOnly) {
            candidates.push(`${normalizedPattern}/**`);
            candidates.push(`**/${normalizedPattern}/**`);
        }

        return candidates.some(candidate =>
            minimatch(relativePath, candidate, {
                dot: true,
                matchBase: !candidate.includes('/'),
                nocase: false,
                nocomment: true,
                nonegate: true,
                noglobstar: false
            })
        );
    }
}
