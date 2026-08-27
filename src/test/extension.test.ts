import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { SearchService } from '../core/search-service';
import { parseSearchQuery } from '../core/search-query';
import { FilterCategory, SearchUI } from '../ui/search-ui';
import { CommandSearchItem, FileSearchItem, SearchItem, SearchItemType, SearchProvider, SymbolSearchItem, TextMatchItem } from '../core/types';
import { buildTextSearchQueryPlans, getBundledRgCandidates, getTextMatchPriority, TextSearchProvider } from '../providers/text-provider';
import { FileSearchProvider } from '../providers/file-provider';
import { SymbolSearchProvider } from '../providers/symbol-provider';
import { FuzzysortAdapter, getIdeaNameMatchScore } from '../search/fuzzysort-adapter';
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

	test('Text boundary quality is only a local tie-breaker', () => {
		assert.strictEqual(getTextMatchPriority('AddDDK1K2K3Value', 3, 9), 40);
		assert.strictEqual(getTextMatchPriority('const sent = true', 6, 10), 25);
	});

	test('Quoted queries use the unquoted term for names and quoted text for content', () => {
		assert.deepStrictEqual(parseSearchQuery('  "sent"  '), {
			raw: '"sent"',
			term: 'sent',
			textPattern: '"sent"',
			exact: true
		});
	});

	test('Bundled ripgrep candidate list covers current VS Code layout', () => {
		assert.deepStrictEqual(
			getBundledRgCandidates('/mock/app', 'darwin', 'arm64'),
			[
				'/mock/app/node_modules/@vscode/ripgrep/bin/rg',
				'/mock/app/node_modules/@vscode/ripgrep-universal/bin/darwin-arm64/rg',
				'/mock/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/darwin-arm64/rg',
				'/mock/rg'
			]
		);
	});

	test('Text search resolves a ripgrep binary from the running VS Code installation', () => {
		const candidates = getBundledRgCandidates(vscode.env.appRoot, process.platform, process.arch);

		assert.ok(candidates.some(candidate => fs.existsSync(candidate)), 'expected an installed VS Code ripgrep binary');
	});

	test('File provider contributes parent directories for path search', async () => {
		const provider = new FileSearchProvider();

		await provider.refresh();

		const directory = (await provider.getItems()).find(item =>
			item.isDirectory && item.label === 'src' && item.description === 'src'
		);

		assert.ok(directory, 'expected the src directory as a searchable path result');
		assert.strictEqual((directory!.iconPath as vscode.ThemeIcon).id, 'folder');
	});

	test('Concurrent file refreshes wait for one workspace scan', async () => {
		const provider = new FileSearchProvider();
		const workspaceFolder = vscode.workspace.workspaceFolders![0];
		const originalFindFiles = vscode.workspace.findFiles;
		let findFilesCalls = 0;
		let releaseFindFiles!: (uris: vscode.Uri[]) => void;
		const pendingFiles = new Promise<vscode.Uri[]>(resolve => {
			releaseFindFiles = resolve;
		});

		(vscode.workspace as any).findFiles = async () => {
			findFilesCalls++;

			return pendingFiles;
		};

		try {
			let secondRefreshCompleted = false;
			const firstRefresh = provider.refresh();
			const secondRefresh = provider.refresh().then(() => {
				secondRefreshCompleted = true;
			});

			await new Promise(resolve => setTimeout(resolve, 0));
			assert.strictEqual(findFilesCalls, 1);
			assert.strictEqual(secondRefreshCompleted, false);

			releaseFindFiles([vscode.Uri.joinPath(workspaceFolder.uri, 'src', 'concurrent.ts')]);
			await Promise.all([firstRefresh, secondRefresh]);

			assert.strictEqual(findFilesCalls, 1);
			assert.ok((await provider.getItems()).some(item => item.label === 'concurrent.ts'));
		} finally {
			(vscode.workspace as any).findFiles = originalFindFiles;
		}
	});

	test('File-set updates replace stale files without rescanning commands', async () => {
		const searchService = new SearchService(context);
		const workspaceFolder = vscode.workspace.workspaceFolders![0];
		const createFile = (name: string): FileSearchItem => {
			const uri = vscode.Uri.joinPath(workspaceFolder.uri, 'src', name);

			return {
				id: `file:${uri.toString()}`,
				type: SearchItemType.File,
				label: name,
				description: `src/${name}`,
				detail: uri.fsPath,
				uri,
				action: async () => {}
			};
		};
		const oldFile = createFile('old.ts');
		const newFile = createFile('new.ts');
		const command: CommandSearchItem = {
			id: 'command:test.search',
			type: SearchItemType.Command,
			label: 'Test Search',
			description: 'Action',
			detail: 'test.search',
			command: 'test.search',
			action: async () => {}
		};
		const fileProvider = new FileSearchProvider();
		const textProvider = new TextSearchProvider();
		let fileRefreshes = 0;
		let commandGets = 0;
		let textRefreshes = 0;
		let cacheWrites = 0;

		(fileProvider as any).refresh = async () => {
			fileRefreshes++;
		};
		(fileProvider as any).getItems = async () => [newFile];
		(textProvider as any).refresh = async () => {
			textRefreshes++;
		};
		(searchService as any).providers = new Map<string, SearchProvider>([
			['files', fileProvider],
			['commands', {
				getItems: async () => {
					commandGets++;

					return [command];
				},
				refresh: async () => {}
			}],
			['text', textProvider]
		]);
		(searchService as any).allItems = [oldFile, command];
		(searchService as any).saveIndexCache = async () => {
			cacheWrites++;
		};

		await (searchService as any).updateIndexFromProviders(true);

		const itemIds = ((searchService as any).allItems as SearchItem[]).map(item => item.id);

		assert.deepStrictEqual(itemIds, [command.id, newFile.id]);
		assert.strictEqual(fileRefreshes, 1);
		assert.strictEqual(commandGets, 0);
		assert.strictEqual(textRefreshes, 1);
		assert.strictEqual(cacheWrites, 1);
	});

	test('Content-only updates refresh text without touching file or command indexes', async () => {
		const searchService = new SearchService(context);
		const fileProvider = new FileSearchProvider();
		const textProvider = new TextSearchProvider();
		let fileRefreshes = 0;
		let fileGets = 0;
		let commandGets = 0;
		let textRefreshes = 0;
		let cacheWrites = 0;

		(fileProvider as any).refresh = async () => {
			fileRefreshes++;
		};
		(fileProvider as any).getItems = async () => {
			fileGets++;

			return [];
		};
		(textProvider as any).refresh = async () => {
			textRefreshes++;
		};
		(searchService as any).providers = new Map<string, SearchProvider>([
			['files', fileProvider],
			['commands', {
				getItems: async () => {
					commandGets++;

					return [];
				},
				refresh: async () => {}
			}],
			['text', textProvider]
		]);
		(searchService as any).saveIndexCache = async () => {
			cacheWrites++;
		};

		await (searchService as any).updateIndexFromProviders(false);

		assert.strictEqual(fileRefreshes, 0);
		assert.strictEqual(fileGets, 0);
		assert.strictEqual(commandGets, 0);
		assert.strictEqual(textRefreshes, 1);
		assert.strictEqual(cacheWrites, 0);
	});

	test('Fuzzy search does not treat priority-only items as matches', async () => {
		const item: FileSearchItem = {
			id: 'directory:unrelated',
			type: SearchItemType.File,
			label: '.openapi-generator',
			description: 'client/.openapi-generator',
			detail: '/tmp/client/.openapi-generator',
			uri: vscode.Uri.file('/tmp/client/.openapi-generator'),
			isDirectory: true,
			priority: 80,
			action: async () => {}
		};

		assert.deepStrictEqual(await new FuzzysortAdapter().search([item], 'zwn'), []);
	});

	test('IDEA-style matcher follows lowercase camel humps and numeric segments', () => {
		const matches = [
			['DateDeviceK1K2K3Value', 'ddk1k2'],
			['NameUtilTest', 'NUT'],
			['NameUtilTest', 'nt'],
			['ReplacePathToMacroMap', 'replmap'],
			['template_impl_template_list_panel', 'templipa'],
			['NoClassDefFoundException', 'ncdfoe'],
			['fxOo', 'foo']
		];

		for (const [name, pattern] of matches) {
			assert.ok(getIdeaNameMatchScore(name, pattern) > 0, `expected ${pattern} to match ${name}`);
		}

		assert.strictEqual(getIdeaNameMatchScore('DateDeviceK1K2K3Value', 'ddk2k1'), 0);
		assert.strictEqual(getIdeaNameMatchScore('NameutilTest', 'NUT'), 0);
		assert.strictEqual(getIdeaNameMatchScore('fxoo', 'foo'), 0);
		assert.strictEqual(getIdeaNameMatchScore('WaterSortClient', 'sent'), 0);
		assert.ok(getIdeaNameMatchScore('Tree', '*tree') > getIdeaNameMatchScore('FooTree', '*tree'));
		assert.ok(getIdeaNameMatchScore('PsiFileImpl', '*psfi') > getIdeaNameMatchScore('PsiJavaFileBaseImpl', '*psfi'));
	});

	test('IDEA-style ranking prefers exact case', async () => {
		const createFile = (label: string): FileSearchItem => ({
			id: `file:${label}`,
			type: SearchItemType.File,
			label,
			description: label,
			detail: label,
			uri: vscode.Uri.file(`/tmp/${label}`),
			action: async () => {}
		});
		const results = await new FuzzysortAdapter().search([
			createFile('Boolean'),
			createFile('boolean')
		], 'boolean');

		assert.deepStrictEqual(results.map(item => item.label), ['boolean', 'Boolean']);
	});

	test('Symbol provider runs one request and keeps only the latest queued query', async () => {
		const provider = new SymbolSearchProvider();
		const releases = new Map<string, () => void>();
		const calls: string[] = [];
		let active = 0;
		let maxActive = 0;
		const createSymbol = (label: string): SymbolSearchItem => ({
			id: `symbol:${label}`,
			type: SearchItemType.Symbol,
			label,
			description: 'Function',
			detail: '/tmp/test.go',
			uri: vscode.Uri.file('/tmp/test.go'),
			range: new vscode.Range(0, 0, 0, label.length),
			symbolKind: vscode.SymbolKind.Function,
			action: async () => {}
		});

		(provider as any).fetchSymbols = async (query: string) => {
			calls.push(query);
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise<void>(resolve => releases.set(query, resolve));
			active--;

			return [createSymbol(query)];
		};

		const first = provider.search('first');
		const discarded = provider.search('second');
		const latest = provider.search('third');

		assert.deepStrictEqual(await discarded, []);
		releases.get('first')!();
		await first;
		await new Promise(resolve => setTimeout(resolve, 0));
		releases.get('third')!();
		assert.strictEqual((await latest)[0].label, 'third');
		assert.deepStrictEqual(calls, ['first', 'third']);
		assert.strictEqual(maxActive, 1);
		assert.strictEqual((await provider.search('third'))[0].label, 'third');
		assert.deepStrictEqual(calls, ['first', 'third'], 'expected the repeated query from cache');
	});

	test('Text provider discards a canceled search generation', async () => {
		const provider = new TextSearchProvider();
		const releases = new Map<string, (items: TextMatchItem[]) => void>();
		const folder = vscode.workspace.workspaceFolders![0];
		const createMatch = (label: string): TextMatchItem => ({
			id: `text:${label}`,
			type: SearchItemType.TextMatch,
			label,
			description: 'src/test.go',
			detail: 'Line 1',
			uri: vscode.Uri.joinPath(folder.uri, 'src', 'test.go'),
			range: new vscode.Range(0, 0, 0, label.length),
			lineText: label,
			matchText: label,
			action: async () => {}
		});

		(provider as any).searchFolder = async (_folder: vscode.WorkspaceFolder, query: string) =>
			new Promise<TextMatchItem[]>(resolve => releases.set(query, resolve));

		const first = provider.search('first');

		await new Promise(resolve => setTimeout(resolve, 0));
		const latest = provider.search('latest');

		await new Promise(resolve => setTimeout(resolve, 0));
		releases.get('first')!([createMatch('first')]);
		assert.deepStrictEqual(await first, []);
		releases.get('latest')!([createMatch('latest')]);
		assert.strictEqual((await latest)[0].label, 'latest');
	});

	test('Text query cache is reused and invalidated after workspace changes', async () => {
		const provider = new TextSearchProvider();
		const folder = vscode.workspace.workspaceFolders![0];
		const match: TextMatchItem = {
			id: 'text:cached',
			type: SearchItemType.TextMatch,
			label: 'cached sent result',
			description: 'src/test.go',
			detail: 'Line 1',
			uri: vscode.Uri.joinPath(folder.uri, 'src', 'test.go'),
			range: new vscode.Range(0, 0, 0, 4),
			lineText: 'cached sent result',
			matchText: 'sent',
			action: async () => {}
		};
		let searches = 0;

		(provider as any).searchFolder = async () => {
			searches++;

			return [match];
		};

		await provider.search('sent');
		await provider.search('sent');
		assert.strictEqual(searches, 1);

		provider.invalidateCache();
		await provider.search('sent');
		assert.strictEqual(searches, 2);
	});

	test('Persistent text index is loaded from disk and serves a new query without ripgrep', async () => {
		const storageUri = vscode.Uri.file(path.join(os.tmpdir(), `search-everywhere-text-index-${Date.now()}`));

		try {
			const builder = new TextSearchProvider(storageUri, 1024 * 1024, 4 * 1024 * 1024);

			await builder.refresh();

			const provider = new TextSearchProvider(storageUri, 1024 * 1024, 4 * 1024 * 1024);
			let ripgrepSearches = 0;

			(provider as any).searchFolder = async () => {
				ripgrepSearches++;

				return [];
			};

			const loadedFiles = await provider.loadCache();
			const results = await provider.search('SkipLevelLabel');

			assert.ok(loadedFiles > 0, 'expected files loaded from the persisted text index');
			assert.ok(results.some(item => item.label.includes('SkipLevelLabel')));
			assert.strictEqual(ripgrepSearches, 0, 'expected a first-time query to use the memory index');
		} finally {
			await vscode.workspace.fs.delete(storageUri, { recursive: true, useTrash: false });
		}
	});

	test('Search service reuses final ranked text results', async () => {
		const searchService = new SearchService(context);
		const provider = new TextSearchProvider();
		const folder = vscode.workspace.workspaceFolders![0];
		const match: TextMatchItem = {
			id: 'text:ranked-cache',
			type: SearchItemType.TextMatch,
			label: 'ChallengeRoomPushEventSent = "sent"',
			description: 'Model/ChallengeRoomPush.go',
			detail: 'Line 41',
			uri: vscode.Uri.joinPath(folder.uri, 'Model', 'ChallengeRoomPush.go'),
			range: new vscode.Range(40, 0, 40, 4),
			lineText: 'ChallengeRoomPushEventSent = "sent"',
			matchText: 'sent',
			action: async () => {}
		};
		let searches = 0;
		let rankings = 0;
		const originalRankResults = (searchService as any).rankResults.bind(searchService);

		(provider as any).search = async () => {
			searches++;

			return [match];
		};
		(searchService as any).rankResults = (...args: unknown[]) => {
			rankings++;

			return originalRankResults(...args);
		};
		(searchService as any).providers.set('text', provider);

		await searchService.searchText('sent');
		await searchService.searchText('sent');
		assert.strictEqual(searches, 1);
		assert.strictEqual(rankings, 1);

		(searchService as any).invalidateQueryCaches();
		await searchService.searchText('sent');
		assert.strictEqual(searches, 2);
		assert.strictEqual(rankings, 2);
	});

	test('Short ASCII queries do not start a full-text workspace scan', async () => {
		const searchService = new SearchService(context);
		const provider = new TextSearchProvider();
		let searches = 0;

		(provider as any).search = async () => {
			searches++;

			return [];
		};
		(searchService as any).providers.set('text', provider);

		assert.deepStrictEqual(await searchService.searchText('se'), []);
		assert.strictEqual(searches, 0);
	});

	test('Global ranking computes each item score once', () => {
		const searchService = new SearchService(context);
		const items: FileSearchItem[] = Array.from({ length: 40 }, (_, index) => ({
			id: `file:${index}`,
			type: SearchItemType.File,
			label: `sent-${index}.go`,
			description: `src/sent-${index}.go`,
			detail: `/tmp/src/sent-${index}.go`,
			uri: vscode.Uri.file(`/tmp/src/sent-${index}.go`),
			action: async () => {}
		}));
		const originalGetResultRank = (searchService as any).getResultRank.bind(searchService);
		let rankCalls = 0;

		(searchService as any).getResultRank = (item: SearchItem, query: unknown) => {
			rankCalls++;

			return originalGetResultRank(item, query);
		};

		searchService.mergeResults('sent', [items]);

		assert.strictEqual(rankCalls, items.length);
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

	test('Text provider scans beyond the display result limit', async () => {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

		assert.ok(workspaceFolder, 'expected the test workspace to be open');

		const fixtureDirectory = vscode.Uri.joinPath(workspaceFolder!.uri, 'late-text-match-regression');
		const token = 'late_text_match_regression_token';

		await vscode.workspace.fs.createDirectory(fixtureDirectory);

		try {
			for (let index = 0; index < 10; index++) {
				const uri = vscode.Uri.joinPath(fixtureDirectory, `noise-${index}.txt`);
				const contents = Buffer.from(`${token}\n${token}\n${token}\nAdsEntryAny\nAdsEntryAny\nAdsEntryAny\n`, 'utf8');

				await vscode.workspace.fs.writeFile(uri, contents);
			}

			const targetUri = vscode.Uri.joinPath(fixtureDirectory, 'target.go');

			await vscode.workspace.fs.writeFile(
				targetUri,
				Buffer.from('const ChallengeRoomPushEventSent = "sent"\n', 'utf8')
			);

			const provider = new TextSearchProvider();
			const results = await provider.search(token);

			assert.ok(results.length > 20, 'expected scanning to continue beyond maxTextResults');

			const searchService = new SearchService(context);
			const rankedResults = await searchService.searchText('sent');

			assert.ok(
				rankedResults.some(item =>
					item.type === SearchItemType.TextMatch &&
					(item as TextMatchItem).uri.toString() === targetUri.toString()
				),
				'expected an exact identifier segment after noisy substring matches'
			);

			const quotedResults = await searchService.searchText('"sent"');

			assert.ok(
				quotedResults.some(item =>
					item.type === SearchItemType.TextMatch &&
					(item as TextMatchItem).uri.toString() === targetUri.toString()
				),
				'expected quoted search to find the exact string literal'
			);
		} finally {
			await vscode.workspace.fs.delete(fixtureDirectory, { recursive: true });
		}
	});

	test('Text match quick pick items are always shown', async () => {
		const searchService = new SearchService(context);
		const results = await searchService.searchText('skip lev');
		const textMatch = results.find(item => item.type === SearchItemType.TextMatch) as TextMatchItem | undefined;

		assert.ok(textMatch, 'expected at least one text match result');

		const searchUi = new SearchUI(searchService, context);
		const quickPickItem = (searchUi as any).createQuickPickItem(textMatch);

		assert.strictEqual(quickPickItem.alwaysShow, true);
		assert.strictEqual(quickPickItem.detail, undefined, 'expected stable single-line quick pick rows');
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

	test('All mode globally ranks exact text above weak file matches without type sections', async () => {
		const searchService = new SearchService(context);
		const uri = vscode.Uri.file('/tmp/ChallengeRoomPush.go');
		const range = new vscode.Range(new vscode.Position(40, 0), new vscode.Position(40, 4));
		const textMatch: TextMatchItem = {
			id: 'text:sent',
			type: SearchItemType.TextMatch,
			label: 'ChallengeRoomPushEventSent = "sent"',
			description: 'Model/ChallengeRoomPush.go',
			detail: 'Line 41',
			uri,
			range,
			lineText: 'ChallengeRoomPushEventSent = "sent"',
			matchText: 'sent',
			priority: 4030,
			action: async () => {}
		};

		const fileItem: FileSearchItem = {
			id: 'file:test',
			type: SearchItemType.File,
			label: 'click_sta_client_version_test.go',
			description: 'Admin/click_sta_client_version_test.go',
			detail: 'Admin/click_sta_client_version_test.go',
			uri,
			action: async () => {}
		};
		const rankedItems = searchService.mergeResults('sent', [[fileItem], [textMatch]]);

		assert.strictEqual(rankedItems[0].id, textMatch.id, 'expected exact text to outrank a weak file subsequence');

		const searchUi = new SearchUI(searchService, context);

		(searchUi as any).activeFilter = FilterCategory.All;
		(searchUi as any).lastQuery = 'sent';
		(searchUi as any).updateSearchItems(rankedItems);

		const quickPickItems = ((searchUi as any).quickPick as vscode.QuickPick<vscode.QuickPickItem>).items;

		assert.ok(quickPickItems.every(item => item.kind !== vscode.QuickPickItemKind.Separator));
		assert.ok(quickPickItems[0].label.includes('ChallengeRoomPushEventSent'));
	});

	test('Symbol search drops loose subsequences and keeps direct name matches', async () => {
		const searchService = new SearchService(context);
		const uri = vscode.Uri.file('/tmp/Model/ChallengeRoomPush.go');
		const range = new vscode.Range(new vscode.Position(40, 0), new vscode.Position(40, 26));
		const createSymbol = (label: string): SymbolSearchItem => ({
			id: `symbol:${label}`,
			type: SearchItemType.Symbol,
			label,
			description: 'Function',
			detail: uri.fsPath,
			uri,
			range,
			symbolKind: vscode.SymbolKind.Function,
			priority: 90,
			action: async () => {}
		});

		(searchService as any).providers.set('symbols', {
			search: async () => [
				createSymbol('ChallengeRoomPushEventSent'),
				createSymbol('WaterSortClient')
			]
		});

		const results = await searchService.searchSymbols('"sent"');

		assert.ok(results.some(item => item.label === 'ChallengeRoomPushEventSent'));
		assert.ok(results.every(item => item.label !== 'WaterSortClient'));
	});

	test('Symbol search keeps IDEA-style camel-hump struct matches', async () => {
		const searchService = new SearchService(context);
		const uri = vscode.Uri.file('/tmp/serverModel/model.go');
		const range = new vscode.Range(new vscode.Position(92, 0), new vscode.Position(92, 27));
		const createSymbol = (label: string): SymbolSearchItem => ({
			id: `symbol:${label}`,
			type: SearchItemType.Class,
			label,
			description: 'Struct',
			detail: uri.fsPath,
			uri,
			range,
			symbolKind: vscode.SymbolKind.Struct,
			priority: 100,
			action: async () => {}
		});

		(searchService as any).providers.set('symbols', {
			search: async () => [
				createSymbol('DateDeviceK1K2K3Value'),
				createSymbol('UnrelatedStruct')
			]
		});

		const results = await searchService.searchSymbols('ddk1k2');

		assert.deepStrictEqual(results.map(item => item.label), ['DateDeviceK1K2K3Value']);
	});

	test('All results rank a camel-hump struct declaration above textual uses', () => {
		const searchService = new SearchService(context);
		const uri = vscode.Uri.file('/tmp/serverModel/model.go');
		const range = new vscode.Range(new vscode.Position(92, 0), new vscode.Position(92, 27));
		const structItem: SymbolSearchItem = {
			id: 'class:DateDeviceK1K2K3Value',
			type: SearchItemType.Class,
			label: 'DateDeviceK1K2K3Value',
			description: 'Struct',
			detail: uri.fsPath,
			uri,
			range,
			symbolKind: vscode.SymbolKind.Struct,
			priority: 100,
			action: async () => {}
		};
		const textItem: TextMatchItem = {
			id: 'text:ddk',
			type: SearchItemType.TextMatch,
			label: 'AITutor.AddDDK1K2K3Value(Global.Db, serverModel.DateDeviceK1K2K3Value{',
			description: 'ThothAIServer/StepByStepStream.go',
			detail: 'Line 309',
			uri: vscode.Uri.file('/tmp/ThothAIServer/StepByStepStream.go'),
			range,
			lineText: 'AITutor.AddDDK1K2K3Value(Global.Db, serverModel.DateDeviceK1K2K3Value{',
			matchText: 'DDK1K2',
			priority: 60,
			score: 1,
			action: async () => {}
		};

		const results = searchService.mergeResults('ddk1k2', [[textItem], [structItem]]);

		assert.strictEqual(results[0].id, structItem.id);
	});

	test('All results keep semantic symbols over duplicate declaration text rows', () => {
		const searchService = new SearchService(context);
		const uri = vscode.Uri.file('/tmp/ThothAIServer/AITutor/tool.go');
		const declarationRange = new vscode.Range(562, 5, 562, 21);
		const usageRange = new vscode.Range(308, 8, 308, 14);
		const symbol: SymbolSearchItem = {
			id: 'symbol:AddDDK1K2K3Value',
			type: SearchItemType.Symbol,
			label: 'AddDDK1K2K3Value',
			description: 'Function',
			detail: uri.fsPath,
			uri,
			range: declarationRange,
			symbolKind: vscode.SymbolKind.Function,
			priority: 90,
			action: async () => {}
		};
		const createText = (id: string, range: vscode.Range, label: string): TextMatchItem => ({
			id,
			type: SearchItemType.TextMatch,
			label,
			description: 'ThothAIServer/AITutor/tool.go',
			detail: `Line ${range.start.line + 1}`,
			uri,
			range,
			lineText: label,
			matchText: 'DDK1K2',
			priority: 70,
			score: 1,
			action: async () => {}
		});
		const declarationText = createText('text:declaration', declarationRange, 'func AddDDK1K2K3Value(...) {');
		const usageText = createText('text:usage', usageRange, 'AITutor.AddDDK1K2K3Value(...)');

		const results = searchService.mergeResults('ddk1k2', [[declarationText, usageText], [symbol]]);

		assert.ok(results.some(item => item.id === symbol.id));
		assert.ok(results.some(item => item.id === usageText.id));
		assert.ok(results.every(item => item.id !== declarationText.id));
	});

	test('Symbol rows show a concise location and a kind-specific icon', () => {
		const searchService = new SearchService(context);
		const searchUi = new SearchUI(searchService, context);
		const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'Model', 'ChallengeRoomPush.go');
		const range = new vscode.Range(new vscode.Position(40, 0), new vscode.Position(40, 26));
		const symbol: SymbolSearchItem = {
			id: 'symbol:ChallengeRoomPushEventSent',
			type: SearchItemType.Symbol,
			label: 'ChallengeRoomPushEventSent',
			description: 'Constant - v12w.x34y.com/dolphin/BrainGameServer/Model',
			detail: uri.fsPath,
			uri,
			range,
			symbolKind: vscode.SymbolKind.Constant,
			priority: 100,
			action: async () => {}
		};
		const item = (searchUi as any).createQuickPickItem(symbol) as vscode.QuickPickItem;

		assert.strictEqual(item.description, 'Model/ChallengeRoomPush.go:41');
		assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'symbol-constant');
		assert.strictEqual(item.detail, undefined);
	});

	test('Quick pick rows sanitize localized objects to strings', () => {
		const searchService = new SearchService(context);
		const searchUi = new SearchUI(searchService, context);
		const malformedItem = {
			id: 'command:localized',
			type: SearchItemType.Command,
			label: { value: 'Localized Action' },
			description: { value: 'Actions' },
			detail: 'localized.action',
			command: 'localized.action',
			action: async () => {}
		} as unknown as SearchItem;
		const item = (searchUi as any).createQuickPickItem(malformedItem) as vscode.QuickPickItem;

		assert.strictEqual(item.label, 'Localized Action');
		assert.strictEqual(item.description, 'Actions');
	});

	test('Search UI performSearch shows Skip Level results in All filter', async () => {
		const searchService = new SearchService(context);
		const searchUi = new SearchUI(searchService, context);
		const originalUpdateSearchItems = (searchUi as any).updateSearchItems.bind(searchUi);
		let renderCount = 0;
		const renderedBatches: SearchItem[][] = [];

		(searchUi as any).activeFilter = FilterCategory.All;
		(searchUi as any).lastQuery = 'skip lev';
		(searchUi as any).isVisible = true;
		(searchUi as any).updateSearchItems = (items: SearchItem[]) => {
			renderCount++;
			renderedBatches.push(items);
			originalUpdateSearchItems(items);
		};

		await (searchUi as any).performSearch('skip lev');

		const quickPickItems = ((searchUi as any).quickPick as vscode.QuickPick<vscode.QuickPickItem>).items;
		const visibleItems = quickPickItems.filter(item => item.kind !== vscode.QuickPickItemKind.Separator);

		assert.ok(visibleItems.length > 0, 'expected visible quick pick items after performSearch');
		assert.ok(visibleItems.some(item =>
			`${item.label} ${item.description || ''} ${item.detail || ''}`.toLowerCase().includes('skip level')
		));
		assert.ok(renderCount >= 1 && renderCount <= 2, `expected at most two stable renders, got ${renderCount}`);

		if (renderedBatches.length === 2) {
			assert.ok(
				renderedBatches[0].every(item => item.type === SearchItemType.File || item.type === SearchItemType.Command),
				'expected the persisted file/action index in the fast first render'
			);
		}
	});

	test('Hidden quick pick cannot be repopulated by a completed stale search', async () => {
		const searchService = new SearchService(context);
		const searchUi = new SearchUI(searchService, context);
		const quickPick = (searchUi as any).quickPick as vscode.QuickPick<vscode.QuickPickItem>;
		let resolveIndexed!: (items: SearchItem[]) => void;
		const indexed = new Promise<SearchItem[]>(resolve => {
			resolveIndexed = resolve;
		});

		(searchService as any).searchIndexed = async () => indexed;
		(searchService as any).searchSymbols = async () => [];
		(searchService as any).searchText = async () => [];
		(searchUi as any).activeFilter = FilterCategory.All;
		(searchUi as any).lastQuery = 'sent';
		(searchUi as any).isVisible = true;

		const pendingSearch = (searchUi as any).performSearch('sent');

		(searchUi as any).onDidHide();
		resolveIndexed([{
			id: 'file:stale',
			type: SearchItemType.File,
			label: 'stale.go',
			description: 'stale.go',
			detail: '/tmp/stale.go',
			uri: vscode.Uri.file('/tmp/stale.go'),
			action: async () => {}
		} as FileSearchItem]);
		await pendingSearch;

		assert.strictEqual(quickPick.items.length, 0);
		clearTimeout((searchService as any).backgroundRefreshTimer);
	});

	test('Changing a query clears old rows before the next search renders', () => {
		const searchService = new SearchService(context);
		const searchUi = new SearchUI(searchService, context);
		const quickPick = (searchUi as any).quickPick as vscode.QuickPick<vscode.QuickPickItem>;

		(searchUi as any).lastQuery = 'sent';
		quickPick.items = [{ label: 'old result' }];
		(searchUi as any).onDidChangeValue('');

		assert.strictEqual(quickPick.items.length, 0);
		clearTimeout((searchUi as any).searchDebounce);
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
