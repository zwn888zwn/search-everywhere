import * as assert from 'assert';
import * as vscode from 'vscode';
import { SearchPanel } from '../ui/search-panel';
import { readCodePreview, CodePreview } from '../ui/code-preview';
import { SearchService } from '../core/search-service';
import { SearchItem, SearchItemType } from '../core/types';

function item(id: string, action = async () => {}): SearchItem {
    return { id, type: SearchItemType.Command, label: id, description: id, detail: id, action };
}

function harness(reader?: (result: SearchItem) => Promise<CodePreview>) {
    const sent: any[] = [];
    const service = {
        startIndexing() {}, cancelPendingSearches() {}, scheduleBackgroundRefresh() {},
        getDefaultItems: async (): Promise<SearchItem[]> => [], searchIndexed: async (): Promise<SearchItem[]> => [], searchSymbols: async (): Promise<SearchItem[]> => [], searchText: async (): Promise<SearchItem[]> => [],
        mergeResults: (_query: string, groups: SearchItem[][]) => groups.flat()
    };
    const context = { workspaceState: { get: () => '', update: async () => {} } } as unknown as vscode.ExtensionContext;
    const subject = new SearchPanel(service as unknown as SearchService, context, reader);
    const controller = subject as any;
    let closed = false;

    controller.panel = {
        webview: { postMessage: async (message: any) => { sent.push(message); } },
        dispose: () => { closed = true; controller.panel = undefined; controller.cancel(); controller.results.clear(); }
    };
    controller.revision = 1;

    return { subject, controller, service, sent, closed: () => closed };
}

suite('Integrated search panel', () => {
    test('previewing and hiding preview never open an item or close the candidate panel', async () => {
        let actions = 0;
        const result = item('one', async () => { actions++; });
        const h = harness();

        try {
            h.controller.results.set(result.id, result);
            await h.controller.receive({ type: 'select', id: result.id, revision: 1, token: 1 });
            await h.controller.receive({ type: 'hidePreview' });
            assert.strictEqual(actions, 0);
            assert.strictEqual(h.closed(), false);
            assert.ok(h.controller.results.has(result.id));
            assert.strictEqual(h.sent[0].type, 'preview');
            await h.controller.receive({ type: 'open', id: result.id, revision: 0 });
            assert.strictEqual(actions, 0, 'stale rows must not execute');
            await h.controller.receive({ type: 'open', id: result.id, revision: 1 });
            assert.strictEqual(actions, 1);
            assert.strictEqual(h.closed(), true);
        } finally { h.subject.dispose(); }
    });

    test('a slower previous preview cannot overwrite a newer selection', async () => {
        let release!: (preview: CodePreview) => void;
        const h = harness(result => result.id === 'slow' ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ path: 'fast' }));

        try {
            h.controller.results.set('slow', item('slow'));
            h.controller.results.set('fast', item('fast'));
            const old = h.controller.receive({ type: 'select', id: 'slow', revision: 1, token: 1 });

            await h.controller.receive({ type: 'select', id: 'fast', revision: 1, token: 2 });
            release({ path: 'slow' });
            await old;
            assert.deepStrictEqual(h.sent.map(message => message.id), ['fast']);
        } finally { h.subject.dispose(); }
    });

    test('closing the preview invalidates in-flight reads but preserves results', async () => {
        let release!: (preview: CodePreview) => void;
        const h = harness(() => new Promise(resolve => { release = resolve; }));

        try {
            h.controller.results.set('slow', item('slow'));
            const pending = h.controller.receive({ type: 'select', id: 'slow', revision: 1, token: 1 });

            await h.controller.receive({ type: 'hidePreview' });
            release({ path: 'slow' });
            await pending;
            assert.strictEqual(h.sent.length, 0);
            assert.ok(h.controller.results.has('slow'));
        } finally { h.subject.dispose(); }
    });

    test('late search contributors cannot restore results for an obsolete query', async () => {
        let release!: (items: SearchItem[]) => void;
        const h = harness();

        h.service.searchIndexed = async () => [item('old-file')];
        h.service.searchSymbols = () => new Promise(resolve => { release = resolve; });
        try {
            const pending = h.controller.search('old', 'all', 1);

            await Promise.resolve();
            await h.controller.receive({ type: 'search', query: 'new', filter: 'files', revision: 2 });
            const previousLength = h.sent.length;

            release([item('old-symbol')]);
            await pending;
            assert.strictEqual(h.sent.length, previousLength);
            assert.strictEqual(h.controller.results.size, 0);
        } finally { h.subject.dispose(); }
    });

    test('default results respect the selected category', async () => {
        const h = harness();

        h.service.getDefaultItems = async () => [{ ...item('file'), type: SearchItemType.File }, item('action')];
        try {
            await h.controller.search('', 'files', 1);
            assert.deepStrictEqual(h.sent[0].items.map((result: any) => result.id), ['file']);
        } finally { h.subject.dispose(); }
    });

    test('preview reads bounded unsaved code with real line numbers and safe syntax HTML', async () => {
        const content = Array.from({ length: 60 }, (_, index) => `const value${index} = ${index};`).join('\n');
        const document = await vscode.workspace.openTextDocument({ language: 'typescript', content });
        const tabCount = vscode.window.tabGroups.all.flatMap(group => group.tabs).length;
        const result = { ...item('code'), type: SearchItemType.TextMatch, uri: document.uri, range: new vscode.Range(25, 6, 25, 13) };
        const edit = new vscode.WorkspaceEdit();

        edit.replace(document.uri, document.lineAt(25).range, 'const changed = "<script>alert(1)</script>";');
        await vscode.workspace.applyEdit(edit);
        const preview = await readCodePreview(result);

        assert.strictEqual(preview.firstLine, 16);
        assert.strictEqual(preview.targetLine, 26);
        assert.strictEqual(preview.lineCount, 41);
        assert.ok(preview.html?.includes('changed'));
        assert.ok(preview.html?.includes('hljs-keyword'));
        assert.ok(!preview.html?.includes('<script>'));
        assert.ok(preview.html?.includes('&lt;script&gt;'));
        assert.strictEqual(vscode.window.tabGroups.all.flatMap(group => group.tabs).length, tabCount);
    });
});
