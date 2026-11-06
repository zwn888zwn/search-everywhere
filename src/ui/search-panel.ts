import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { SearchService } from '../core/search-service';
import { SearchItem, SearchItemType } from '../core/types';
import { readCodePreview, resultPath } from './code-preview';

const filters = ['all', 'classes', 'files', 'symbols', 'actions', 'text'] as const;

type Filter = typeof filters[number];
const types: Partial<Record<Filter, SearchItemType[]>> = {
    classes: [SearchItemType.Class], files: [SearchItemType.File], symbols: [SearchItemType.Symbol],
    actions: [SearchItemType.Command], text: [SearchItemType.TextMatch]
};

export class SearchPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private generation = 0;
    private previewGeneration = 0;
    private revision = -1;
    private results = new Map<string, SearchItem>();
    private timer: NodeJS.Timeout | undefined;
    private opening = false;
    private selection: { id: string; token: number } | undefined;
    private documentSubscription: vscode.Disposable;

    constructor(private service: SearchService, private context: vscode.ExtensionContext, private previewReader = readCodePreview) {
        this.documentSubscription = vscode.workspace.onDidChangeTextDocument(event => {
            const selection = this.selection;
            const item = selection && this.results.get(selection.id);

            if (item && 'uri' in item && item.uri instanceof vscode.Uri && item.uri.toString() === event.document.uri.toString()) {
                void this.select(selection.id, this.revision, selection.token);
            }
        });
    }

    public show(): void {
        if (this.panel) {
            this.panel.reveal();
            void this.panel.webview.postMessage({ type: 'focus' });

            return;
        }

        this.opening = false;
        this.panel = vscode.window.createWebviewPanel('searchEverywhere.integrated', 'Search Everywhere', vscode.ViewColumn.Active, {
            enableScripts: true, retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        });
        this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'icon.png');
        this.panel.webview.html = this.html(this.panel.webview);
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.cancel();
            this.results.clear();
            this.revision = -1;
            this.service.scheduleBackgroundRefresh(1500);
        });
        this.panel.webview.onDidReceiveMessage(message => { void this.receive(message); });
    }

    private cancel(): void {
        clearTimeout(this.timer);
        this.generation++;
        this.previewGeneration++;
        this.selection = undefined;
        this.service.cancelPendingSearches();
    }

    private async receive(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object' || !('type' in message)) { return; }

        const value = message as Record<string, unknown>;

        if (value.type === 'ready') {
            await this.panel?.webview.postMessage({ type: 'init', query: this.context.workspaceState.get('searchEverywhere.lastQuery', '') });
        } else if (value.type === 'close') {
            this.panel?.dispose();
        } else if (value.type === 'search' && typeof value.query === 'string' && value.query.length <= 10000 && filters.includes(value.filter as Filter) && Number.isSafeInteger(value.revision)) {
            this.cancel();
            this.revision = value.revision as number;
            this.results.clear();
            const query = value.query;
            const filter = value.filter as Filter;
            const revision = this.revision;

            if (query.trim()) { void this.context.workspaceState.update('searchEverywhere.lastQuery', query.trim()); }

            this.timer = setTimeout(() => { void this.search(query, filter, revision); }, 120);
        } else if (value.type === 'select' && typeof value.id === 'string' && value.revision === this.revision && Number.isSafeInteger(value.token)) {
            await this.select(value.id, this.revision, value.token as number);
        } else if (value.type === 'hidePreview') {
            this.previewGeneration++;
            this.selection = undefined;
        } else if (value.type === 'open' && typeof value.id === 'string' && value.revision === this.revision) {
            await this.open(value.id);
        }
    }

    private async search(query: string, filter: Filter, revision: number): Promise<void> {
        const generation = this.generation;
        const current = () => !!this.panel && generation === this.generation && revision === this.revision;
        const publish = (items: SearchItem[], busy: boolean, error?: string) => {
            if (!current()) { return; }

            const visible = types[filter] ? items.filter(item => types[filter]!.includes(item.type)) : items;

            this.results = new Map(visible.map(item => [item.id, item]));
            void this.panel?.webview.postMessage({
                type: 'results', revision, busy, error,
                items: visible.map(item => ({
                    id: item.id, type: item.type, label: String(item.label).replace(/\$\([^)]+\)/g, ''),
                    path: resultPath(item),
                    line: 'range' in item && item.range instanceof vscode.Range ? item.range.start.line + 1 : undefined
                }))
            });
        };

        try {
            this.service.startIndexing();
            if (!query.trim()) {
                publish(await this.service.getDefaultItems(), false);
            } else if (filter === 'all') {
                const indexed = this.service.searchIndexed(query);
                const all = Promise.allSettled([indexed, this.service.searchSymbols(query), this.service.searchText(query)]);
                const fast = await indexed.catch(() => []);

                if (fast.length) { publish(fast, true); }

                const settled = await all;
                const groups = settled.filter((result): result is PromiseFulfilledResult<SearchItem[]> => result.status === 'fulfilled').map(result => result.value);

                publish(this.service.mergeResults(query, groups), false, settled.some(result => result.status === 'rejected') ? 'Some search sources are unavailable.' : undefined);
            } else {
                const matches = filter === 'text' ? await this.service.searchText(query)
                    : filter === 'symbols' || filter === 'classes' ? await this.service.searchSymbols(query, types[filter])
                        : await this.service.searchIndexed(query, types[filter]);

                publish(this.service.mergeResults(query, [matches]), false);
            }
        } catch (error) {
            publish([], false, `Search failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async select(id: string, revision: number, token: number): Promise<void> {
        const item = this.results.get(id);
        const generation = ++this.previewGeneration;

        this.selection = { id, token };
        if (!item) { return; }

        try {
            const preview = await this.previewReader(item);

            if (this.panel && generation === this.previewGeneration && revision === this.revision) {
                await this.panel.webview.postMessage({ type: 'preview', revision, id, token, preview });
            }
        } catch (error) {
            if (this.panel && generation === this.previewGeneration && revision === this.revision) {
                await this.panel.webview.postMessage({ type: 'preview', revision, id, token, preview: { path: resultPath(item), message: `Cannot preview: ${error instanceof Error ? error.message : String(error)}` } });
            }
        }
    }

    private async open(id: string): Promise<void> {
        const item = this.results.get(id);

        if (!item || this.opening) { return; }

        this.opening = true;
        this.panel?.dispose();
        try {
            await item.action();
        } catch (error) {
            void vscode.window.showErrorMessage(`Cannot open search result: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.opening = false;
        }
    }

    public close(): void {
        this.panel?.dispose();
    }

    public dispose(): void {
        this.close();
        this.cancel();
        this.documentSubscription.dispose();
    }

    private html(webview: vscode.Webview): string {
        const nonce = randomBytes(16).toString('hex');
        const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));

        return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${asset('search-panel.css')}"></head><body>
<main class="shell" aria-label="Search Everywhere">
<header><nav role="tablist" aria-label="Search category">${filters.map((filter, index) => `<button role="tab" data-filter="${filter}" aria-selected="${index === 0}">${filter[0].toUpperCase() + filter.slice(1)}</button>`).join('')}</nav><button id="toggle-preview" class="icon-button" title="Hide preview" aria-label="Hide preview" aria-pressed="true">▤</button><button id="close" class="icon-button" title="Close search" aria-label="Close search">×</button></header>
<div class="search-field"><span aria-hidden="true">⌕</span><input id="query" type="search" placeholder="Search files, symbols, actions and text" aria-label="Search everywhere" autocomplete="off" spellcheck="false"><span id="busy" aria-live="polite"></span></div>
<div id="results" role="listbox" aria-label="Search results" tabindex="0"></div>
<div id="splitter" role="separator" aria-label="Resize code preview" aria-orientation="horizontal" tabindex="0"></div>
<section id="preview" aria-label="Code preview"><div class="preview-header"><span id="preview-path" title=""></span><span id="language"></span><button id="open" title="Open selected result" disabled>Open ↵</button></div><div id="code-viewport"><div id="preview-message">Select a result to preview its context</div><div id="code-content" hidden><div id="active-line"></div><pre id="line-numbers" aria-hidden="true"></pre><pre id="code"></pre></div></div><div id="preview-note" hidden>Long lines are shortened. Open the file for the full source.</div></section>
<footer><span>↑↓ Preview <b>·</b> Enter / double-click Open <b>·</b> Esc Close</span><span id="count" aria-live="polite"></span></footer>
</main><script nonce="${nonce}" src="${asset('search-panel.js')}"></script></body></html>`;
    }
}
