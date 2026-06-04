import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConfiguration } from './config';
import Logger from './logging';
import { minimatch } from 'minimatch';
import { isWorkspaceFile } from './workspace';

interface GitIgnoreRule {
    basePath: string;
    pattern: string;
}

/**
 * Utility for managing exclusion patterns that are shared across providers
 */
export class ExclusionPatterns {
    private static gitIgnoreCache = new Map<string, GitIgnoreRule[]>();

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
            '**/govendor/**',
            '**/pkg/mod/**',
            '**/pkg/sumdb/**',
            '**/src/github.com/**',
            '**/src/golang.org/**',
            '**/src/google.golang.org/**',
            '**/src/go.uber.org/**',
            '**/src/gopkg.in/**',

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
    public static getExclusionGlob(workspaceFolder?: vscode.WorkspaceFolder): string {
        const patterns = workspaceFolder
            ? this.getSearchExcludePatterns(workspaceFolder)
            : this.getExclusionPatterns();
        const glob = `{${patterns.join(',')}}`;

        Logger.debug(`Generated exclusion glob pattern with ${patterns.length} patterns`);

        return glob;
    }

    public static getSearchExcludePatterns(workspaceFolder: vscode.WorkspaceFolder): string[] {
        return [
            ...this.getExclusionPatterns(),
            ...this.getGitIgnoreGlobPatterns(workspaceFolder)
        ];
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
        const rules = this.getGitIgnoreRules(workspaceFolder);
        let ignored = false;

        for (const rule of rules) {
            const scopedPath = this.toScopedRelativePath(relativePath, rule.basePath);

            if (scopedPath === undefined) {
                continue;
            }

            const pattern = rule.pattern;
            const negated = pattern.startsWith('!');
            const rawPattern = negated ? pattern.substring(1) : pattern;

            if (this.matchesGitIgnorePattern(scopedPath, rawPattern)) {
                ignored = !negated;
            }
        }

        return ignored;
    }

    private static getGitIgnoreRules(workspaceFolder: vscode.WorkspaceFolder): GitIgnoreRule[] {
        const workspacePath = workspaceFolder.uri.fsPath;
        const cached = this.gitIgnoreCache.get(workspacePath);

        if (cached) {
            return cached;
        }

        try {
            const rules = this.collectGitIgnoreRules(workspacePath);

            this.gitIgnoreCache.set(workspacePath, rules);

            return rules;
        } catch {
            this.gitIgnoreCache.set(workspacePath, []);

            return [];
        }
    }

    private static getGitIgnoreGlobPatterns(workspaceFolder: vscode.WorkspaceFolder): string[] {
        const rules = this.getGitIgnoreRules(workspaceFolder);
        const expanded = new Set<string>();

        for (const rule of rules) {
            const pattern = rule.pattern;

            if (pattern.startsWith('!')) {
                continue;
            }

            for (const candidate of this.expandGitIgnorePatternToGlobs(pattern, rule.basePath)) {
                expanded.add(candidate);
            }
        }

        return [...expanded];
    }

    private static collectGitIgnoreRules(workspacePath: string): GitIgnoreRule[] {
        const rules: GitIgnoreRule[] = [];
        const stack = [''];
        const skippedDirs = new Set(['.git', 'node_modules']);

        while (stack.length > 0) {
            const relativeDir = stack.pop()!;
            const absoluteDir = path.join(workspacePath, relativeDir);
            const gitIgnorePath = path.join(absoluteDir, '.gitignore');

            if (fs.existsSync(gitIgnorePath)) {
                const content = fs.readFileSync(gitIgnorePath, 'utf8');
                const patterns = content
                    .split(/\r?\n/)
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith('#'));

                for (const pattern of patterns) {
                    rules.push({
                        basePath: relativeDir.split(path.sep).join('/'),
                        pattern
                    });
                }
            }

            let entries: fs.Dirent[];

            try {
                entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries) {
                if (!entry.isDirectory() || skippedDirs.has(entry.name)) {
                    continue;
                }

                const childRelativeDir = relativeDir
                    ? path.posix.join(relativeDir.split(path.sep).join('/'), entry.name)
                    : entry.name;

                stack.push(childRelativeDir);
            }
        }

        return rules;
    }

    private static expandGitIgnorePatternToGlobs(pattern: string, basePath: string): string[] {
        let normalizedPattern = pattern.replace(/\\/g, '/').trim();

        if (!normalizedPattern) {
            return [];
        }

        if (normalizedPattern.startsWith('/')) {
            normalizedPattern = normalizedPattern.substring(1);
        }

        const directoryOnly = normalizedPattern.endsWith('/');

        if (directoryOnly) {
            normalizedPattern = normalizedPattern.slice(0, -1);
        }

        if (!normalizedPattern) {
            return [];
        }

        const hasSlash = normalizedPattern.includes('/');
        const relativeCandidates = hasSlash
            ? [normalizedPattern, `${normalizedPattern}/**`]
            : [normalizedPattern, `**/${normalizedPattern}`, `**/${normalizedPattern}/**`];

        if (directoryOnly) {
            relativeCandidates.push(`${normalizedPattern}/**`);
            relativeCandidates.push(`**/${normalizedPattern}/**`);
        }

        return [...new Set(relativeCandidates.map(candidate => this.prefixGitIgnoreGlob(basePath, candidate)))];
    }

    private static prefixGitIgnoreGlob(basePath: string, candidate: string): string {
        if (!basePath) {
            return candidate;
        }

        if (candidate.startsWith('**/')) {
            return `${basePath}/${candidate}`;
        }

        return `${basePath}/${candidate}`;
    }

    private static toScopedRelativePath(relativePath: string, basePath: string): string | undefined {
        if (!basePath) {
            return relativePath;
        }

        if (relativePath === basePath) {
            return '';
        }

        if (!relativePath.startsWith(`${basePath}/`)) {
            return undefined;
        }

        return relativePath.substring(basePath.length + 1);
    }

    private static matchesGitIgnorePattern(relativePath: string, pattern: string): boolean {
        return this.expandGitIgnorePatternToGlobs(pattern, '').some(candidate =>
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
