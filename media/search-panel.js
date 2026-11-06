/* global acquireVsCodeApi */
(() => {
    'use strict';
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    const saved = vscode.getState() || {};
    const state = { query: '', filter: 'all', revision: 0, token: 0, items: [], selected: null, previewVisible: saved.previewVisible !== false };
    const rows = new Map();
    const query = $('query');
    const results = $('results');
    const code = $('code');
    let initialized = false;

    function persist() {
        vscode.setState({ query: state.query, filter: state.filter, previewVisible: state.previewVisible });
    }

    function clearPreview(message = 'Select a result to preview its context') {
        $('preview-message').textContent = message;
        $('preview-message').hidden = false;
        $('code-content').hidden = true;
        $('preview-path').textContent = '';
        $('language').textContent = '';
        $('preview-note').hidden = true;
        code.replaceChildren();
    }

    function search() {
        state.query = query.value;
        state.revision++;
        state.token++;
        state.items = [];
        state.selected = null;
        rows.clear();
        results.replaceChildren();
        results.scrollTop = 0;
        results.setAttribute('aria-busy', 'true');
        $('busy').textContent = 'Searching…';
        $('count').textContent = '';
        $('open').disabled = true;
        clearPreview('Searching…');
        persist();
        vscode.postMessage({ type: 'search', query: state.query, filter: state.filter, revision: state.revision });
    }

    function choose(id, reveal = false, force = false) {
        const changed = state.selected !== id;
        state.selected = id;
        for (const [key, row] of rows) {
            row.element.setAttribute('aria-selected', String(key === id));
        }
        const row = rows.get(id);
        if (row) {
            results.setAttribute('aria-activedescendant', row.element.id);
            query.setAttribute('aria-activedescendant', row.element.id);
            if (reveal) { row.element.scrollIntoView({ block: 'nearest' }); }
        } else {
            results.removeAttribute('aria-activedescendant');
            query.removeAttribute('aria-activedescendant');
        }
        $('open').disabled = !row;
        $('open').textContent = state.items.find(item => item.id === id)?.type === 'command' ? 'Run ↵' : 'Open ↵';
        if ((changed || force) && row && state.previewVisible) {
            state.token++;
            clearPreview('Loading preview…');
            vscode.postMessage({ type: 'select', revision: state.revision, id, token: state.token });
        }
    }

    function open() {
        if (state.selected) {
            vscode.postMessage({ type: 'open', revision: state.revision, id: state.selected });
        }
    }

    function labelWithMatch(element, text) {
        element.replaceChildren();
        const term = state.query.trim().replace(/^"|"$/g, '');
        const index = term ? text.toLowerCase().indexOf(term.toLowerCase()) : -1;
        if (index < 0) { element.textContent = text; return; }
        const match = document.createElement('mark');
        match.textContent = text.slice(index, index + term.length);
        element.append(text.slice(0, index), match, text.slice(index + term.length));
    }

    function renderResults(message) {
        const previous = state.selected;
        const scroll = results.scrollTop;
        state.items = message.items;
        const fragment = document.createDocumentFragment();
        const ids = new Set(message.items.map(item => item.id));
        for (const key of rows.keys()) { if (!ids.has(key)) { rows.delete(key); } }
        message.items.forEach((item, index) => {
            let row = rows.get(item.id);
            if (!row) {
                const element = document.createElement('div');
                element.className = 'result';
                element.setAttribute('role', 'option');
                element.tabIndex = -1;
                const icon = document.createElement('span');
                icon.className = `kind kind-${item.type}`;
                icon.textContent = ({ file: 'F', symbol: 'S', class: 'C', text: '≡', command: '›' })[item.type] || '·';
                icon.setAttribute('aria-hidden', 'true');
                const label = document.createElement('span');
                label.className = 'result-label';
                const path = document.createElement('span');
                path.className = 'result-path';
                element.append(icon, label, path);
                element.addEventListener('click', () => { results.focus(); choose(item.id); });
                element.addEventListener('dblclick', open);
                row = { element, label, path, labelText: null, pathText: null };
                rows.set(item.id, row);
            }
            row.element.id = `result-${index}`;
            if (row.labelText !== item.label) {
                labelWithMatch(row.label, item.label);
                row.labelText = item.label;
            }
            const location = item.path + (item.line ? ':' + item.line : '');
            if (row.pathText !== location) { row.path.textContent = location; row.pathText = location; }
            row.element.title = `${item.label}\n${location}`;
            fragment.append(row.element);
        });
        results.replaceChildren(fragment);
        results.scrollTop = scroll;
        const selected = ids.has(previous) ? previous : message.items[0]?.id || null;
        choose(selected, false);
        results.setAttribute('aria-busy', String(message.busy));
        $('busy').textContent = message.busy ? 'Searching…' : '';
        $('count').textContent = message.error || `${message.items.length} result${message.items.length === 1 ? '' : 's'}`;
        $('count').title = message.error || '';
        if (!message.items.length) {
            const empty = document.createElement('div');
            empty.className = 'empty-results';
            empty.textContent = message.busy ? 'Searching…' : message.error || 'No results';
            results.append(empty);
            clearPreview(message.busy ? 'Searching…' : 'Try another search or category');
        }
    }

    function markSource(start, end) {
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) { return; }
        const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
        const matches = [];
        let offset = 0;
        while (walker.nextNode()) {
            const node = walker.currentNode;
            const next = offset + node.textContent.length;
            if (next > start && offset < end) { matches.push({ node, from: Math.max(0, start - offset), to: Math.min(node.textContent.length, end - offset) }); }
            offset = next;
        }
        for (const { node, from, to } of matches) {
            const text = node.textContent;
            const mark = document.createElement('mark');
            mark.className = 'source-match';
            mark.textContent = text.slice(from, to);
            node.replaceWith(document.createTextNode(text.slice(0, from)), mark, document.createTextNode(text.slice(to)));
        }
    }

    function renderPreview(preview) {
        $('preview-path').textContent = preview.path || '';
        $('preview-path').title = preview.path || '';
        $('language').textContent = preview.language || '';
        if (preview.message) {
            $('preview-message').textContent = preview.message;
            $('preview-message').hidden = false;
            $('code-content').hidden = true;
            return;
        }
        $('preview-message').hidden = true;
        $('code-content').hidden = false;
        $('line-numbers').textContent = Array.from({ length: preview.lineCount }, (_, index) => preview.firstLine + index).join('\n');
        // Only the extension's escaping syntax highlighter produces this HTML.
        code.innerHTML = preview.html || '';
        markSource(preview.highlightStart, preview.highlightEnd);
        $('active-line').style.top = `${8 + (preview.targetLine - preview.firstLine) * 20}px`;
        $('preview-note').hidden = !preview.truncated;
        $('code-viewport').scrollLeft = 0;
        $('code-viewport').scrollTop = Math.max(0, (preview.targetLine - preview.firstLine) * 20 - $('code-viewport').clientHeight * 0.35);
    }

    function setPreviewVisible(visible) {
        state.previewVisible = visible;
        document.querySelector('.shell').classList.toggle('without-preview', !visible);
        $('preview').hidden = !visible;
        $('splitter').hidden = !visible;
        $('toggle-preview').setAttribute('aria-pressed', String(visible));
        $('toggle-preview').setAttribute('aria-label', visible ? 'Hide preview' : 'Show preview');
        $('toggle-preview').title = visible ? 'Hide preview' : 'Show preview';
        if (visible) { choose(state.selected, false, true); }
        else { state.token++; vscode.postMessage({ type: 'hidePreview' }); }
        persist();
    }

    function setFilter(filter) {
        state.filter = filter;
        for (const tab of document.querySelectorAll('[data-filter]')) {
            tab.setAttribute('aria-selected', String(tab.dataset.filter === filter));
        }
        search();
        query.focus();
    }

    query.addEventListener('input', search);
    for (const tab of document.querySelectorAll('[data-filter]')) {
        tab.addEventListener('click', () => setFilter(tab.dataset.filter));
        tab.addEventListener('keydown', event => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                const tabs = [...document.querySelectorAll('[data-filter]')];
                const next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
                event.preventDefault(); setFilter(next.dataset.filter); next.focus();
            }
        });
    }
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); vscode.postMessage({ type: 'close' }); return; }
        if (!(event.target === query || event.target === results || event.target.closest('.result'))) { return; }
        if (event.isComposing) { return; }
        if (event.key === 'Enter') { event.preventDefault(); open(); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const index = state.items.findIndex(item => item.id === state.selected);
            const next = Math.max(0, Math.min(state.items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
            if (state.items[next]) { choose(state.items[next].id, true); }
        }
    });
    $('open').addEventListener('click', open);
    $('close').addEventListener('click', () => vscode.postMessage({ type: 'close' }));
    $('toggle-preview').addEventListener('click', () => setPreviewVisible(!state.previewVisible));

    const splitter = $('splitter');
    function resizeResults(height) {
        const available = document.querySelector('.shell').clientHeight - 130;
        const next = Math.max(48, Math.min(Math.max(48, available - 60), height));
        results.style.flexBasis = `${next}px`;
        splitter.setAttribute('aria-valuenow', String(Math.round(next)));
    }
    splitter.addEventListener('pointerdown', event => {
        event.preventDefault();
        splitter.setPointerCapture(event.pointerId);
        const start = event.clientY;
        const height = results.clientHeight;
        const move = next => resizeResults(height + next.clientY - start);
        const finish = () => {
            splitter.removeEventListener('pointermove', move);
            splitter.removeEventListener('pointerup', finish);
            splitter.removeEventListener('pointercancel', finish);
        };
        splitter.addEventListener('pointermove', move);
        splitter.addEventListener('pointerup', finish);
        splitter.addEventListener('pointercancel', finish);
    });
    splitter.addEventListener('keydown', event => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault(); resizeResults(results.clientHeight + (event.key === 'ArrowDown' ? 20 : -20));
        }
    });
    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'init' && !initialized) {
            initialized = true;
            query.value = typeof saved.query === 'string' ? saved.query : message.query || '';
            setPreviewVisible(state.previewVisible);
            setFilter(['all', 'classes', 'files', 'symbols', 'actions', 'text'].includes(saved.filter) ? saved.filter : 'all');
            query.select();
        } else if (message.type === 'focus') {
            query.focus();
        } else if (message.type === 'results' && message.revision === state.revision) {
            renderResults(message);
        } else if (message.type === 'preview' && message.revision === state.revision && message.id === state.selected && message.token === state.token && state.previewVisible) {
            renderPreview(message.preview);
        }
    });
    vscode.postMessage({ type: 'ready' });
})();
