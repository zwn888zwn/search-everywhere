import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { SearchService } from '../core/search-service';
import { FilterCategory, SearchUI } from '../ui/search-ui';
import { FileSearchItem, SearchItemType, TextMatchItem } from '../core/types';
import { buildTextSearchQueryPlans, getBundledRgCandidates } from '../providers/text-provider';
// import * as myExtension from '../../extension';

class InMemoryMemento implements vscode.Memento {
	private readonly store = new Map<string, unknown>();

	public keys(): readonly string[] {
		return [...this.store.keys()];
	}

	public get<T>(key: string): T | undefined;
	public get<T>(key: string, defaultValue: T): T;
	public get<T>(key: string, defaultValue?: T): T | undefined {
		return this.store.has(key) ? this.store.get(key) as T : defaultValue;
	}

	public update(key: string, value: unknown): Thenable<void> {
		this.store.set(key, value);

		return Promise.resolve();
	}
}

class InMemoryGlobalMemento extends InMemoryMemento {
	public setKeysForSync(_keys: readonly string[]): void {}
}

function createTestContext(workspaceState: vscode.Memento): vscode.ExtensionContext {
	const extensionPath = path.resolve(__dirname, '../..');
	const storagePath = path.join(os.tmpdir(), 'search-everywhere-test-storage');
	const storageUri = vscode.Uri.file(storagePath);

	return {
		subscriptions: [],
		workspaceState,
		globalState: new InMemoryGlobalMemento(),
		extensionUri: vscode.Uri.file(extensionPath),
		extensionPath,
		asAbsolutePath: (relativePath: string) => path.join(extensionPath, relativePath),
		storageUri,
		storagePath,
		globalStorageUri: storageUri,
		globalStoragePath: storagePath,
		logUri: storageUri,
		logPath: storagePath,
		secrets: {
			get: async () => undefined,
			store: async () => {},
			delete: async () => {},
			onDidChange: () => new vscode.Disposable(() => {})
		},
		environmentVariableCollection: {} as vscode.GlobalEnvironmentVariableCollection,
		extensionMode: vscode.ExtensionMode.Test,
		extension: {} as vscode.Extension<any>,
		languageModelAccessInformation: {} as vscode.LanguageModelAccessInformation
	} as unknown as vscode.ExtensionContext;
}

suite('Extension Test Suite', () => {
	let workspaceState = new InMemoryMemento();
	let context = createTestContext(workspaceState);

	setup(() => {
		workspaceState = new InMemoryMemento();
		context = createTestContext(workspaceState);
	});

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('Text search adds flexible separator fallback for spaced queries', () => {
		assert.deepStrictEqual(buildTextSearchQueryPlans('skip level'), [
			{ pattern: 'skip level', useRegex: false },
			{ pattern: 'skip[\\s_-]*level', useRegex: true }
		]);
	});

	test('Text search keeps literal-only lookup for single token queries', () => {
		assert.deepStrictEqual(buildTextSearchQueryPlans('skipLevel'), [
			{ pattern: 'skipLevel', useRegex: false }
		]);
	});

	test('Bundled ripgrep candidate list covers current VS Code layout', () => {
		assert.deepStrictEqual(
			getBundledRgCandidates('/mock/app', 'darwin', 'arm64'),
			[
				'/mock/app/node_modules/@vscode/ripgrep/bin/rg',
				'/mock/app/node_modules/@vscode/ripgrep-universal/bin/darwin-arm64/rg',
				'/mock/rg'
			]
		);
	});

	test('Text search finds Skip Level matches in the fixture workspace', async () => {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

		assert.ok(workspaceFolder, 'expected the test workspace to be open');
		assert.strictEqual(path.basename(workspaceFolder!.uri.fsPath), 'sample-workspace');

		const searchService = new SearchService(context);
		const results = await searchService.searchText('skip lev');

		assert.ok(results.length > 0, 'expected text search results for "skip lev"');
		assert.ok(results.some(item => item.type === SearchItemType.TextMatch), 'expected at least one text match result');

		const skipLevelMatch = results.find(item => {
			const lineText = (item as TextMatchItem).lineText || item.label;

			return lineText.toLowerCase().includes('skip level');
		});

		assert.ok(skipLevelMatch, 'expected a result containing "Skip Level"');
		assert.ok(results.every(item => !item.description.includes('tmp/go-build')), 'expected nested .gitignore files to exclude tmp/go-build');
	});

	test('Text match quick pick items are always shown', async () => {
		const searchService = new SearchService(context);
		const results = await searchService.searchText('skip lev');
		const textMatch = results.find(item => item.type === SearchItemType.TextMatch) as TextMatchItem | undefined;

		assert.ok(textMatch, 'expected at least one text match result');

		const searchUi = new SearchUI(searchService, context);
		const quickPickItem = (searchUi as any).createQuickPickItem(textMatch);

		assert.strictEqual(quickPickItem.alwaysShow, true);
	});

	test('Search UI keeps text results in quick pick items', async () => {
		const searchService = new SearchService(context);
		const results = await searchService.searchText('skip lev');
		const searchUi = new SearchUI(searchService, context);

		(searchUi as any).activeFilter = FilterCategory.Text;
		(searchUi as any).updateSearchItems(results);

		const quickPickItems = ((searchUi as any).quickPick as vscode.QuickPick<vscode.QuickPickItem>).items;
		const visibleItems = quickPickItems.filter(item => item.kind !== vscode.QuickPickItemKind.Separator);

		assert.ok(visibleItems.length > 0, 'expected visible quick pick text items');
		assert.ok(visibleItems.some(item => (item.label || '').toLowerCase().includes('skip level')));
	});

	test('Search UI performSearch shows Skip Level results in All filter', async () => {
		const searchService = new SearchService(context);
		const searchUi = new SearchUI(searchService, context);

		(searchUi as any).activeFilter = FilterCategory.All;
		(searchUi as any).lastQuery = 'skip lev';

		await (searchUi as any).performSearch('skip lev');

		const quickPickItems = ((searchUi as any).quickPick as vscode.QuickPick<vscode.QuickPickItem>).items;
		const visibleItems = quickPickItems.filter(item => item.kind !== vscode.QuickPickItemKind.Separator);

		assert.ok(visibleItems.length > 0, 'expected visible quick pick items after performSearch');
		assert.ok(visibleItems.some(item =>
			`${item.label} ${item.description || ''} ${item.detail || ''}`.toLowerCase().includes('skip level')
		));
	});

	test('File path queries with :line jump to the requested line', async () => {
		const searchService = new SearchService(context);
		const results = await searchService.search('src/skip_level.go:3');
		const fileResult = results.find(item => item.type === SearchItemType.File) as FileSearchItem | undefined;

		assert.ok(fileResult, 'expected a file result for path:line query');
		assert.ok(fileResult.range instanceof vscode.Range, 'expected a target range on the file result');
		assert.strictEqual(fileResult.range?.start.line, 2);
		assert.strictEqual(fileResult.range?.start.character, 0);
	});
});
