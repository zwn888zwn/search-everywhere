import * as vscode from 'vscode';
import hljs from 'highlight.js/lib/core';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import cpp from 'highlight.js/lib/languages/cpp';
import { SearchItem } from '../core/types';

for (const [name, grammar] of Object.entries({ go, java, javascript, typescript, python, json, xml, css, sql, bash, yaml, markdown, cpp })) {
    hljs.registerLanguage(name, grammar);
}

export interface CodePreview {
    path: string;
    language?: string;
    firstLine?: number;
    lineCount?: number;
    targetLine?: number;
    html?: string;
    highlightStart?: number;
    highlightEnd?: number;
    message?: string;
    truncated?: boolean;
}

export function resultPath(item: SearchItem): string {
    if ('uri' in item && item.uri instanceof vscode.Uri) {
        return vscode.workspace.asRelativePath(item.uri, true);
    }

    return String(item.description || '');
}

/** Read a bounded context without revealing or opening an editor tab. */
export async function readCodePreview(item: SearchItem): Promise<CodePreview> {
    const path = resultPath(item);

    if (!('uri' in item) || !(item.uri instanceof vscode.Uri)) {
        return { path, message: item.detail || item.description || 'Press Enter to run this action.' };
    }

    if ('isDirectory' in item && item.isDirectory) {
        return { path, message: 'Directory — press Enter to open it in Explorer.' };
    }

    const uri = item.uri;
    let document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());

    if (!document) {
        const stat = await vscode.workspace.fs.stat(uri);

        if (stat.size > 2 * 1024 * 1024) {
            return { path, message: 'This file is too large for an inline preview. Press Enter to open it.' };
        }

        document = await vscode.workspace.openTextDocument(uri);
    }

    const range = 'range' in item && item.range instanceof vscode.Range ? document.validateRange(item.range) : undefined;
    const target = Math.min(range?.start.line ?? 0, document.lineCount - 1);
    const first = Math.max(0, target - 10);
    const end = Math.min(document.lineCount, target + 31);
    const lines: string[] = [];
    let length = 0;
    let truncated = false;
    let highlightStart = 0;
    let highlightEnd = 0;

    for (let line = first; line < end; line++) {
        const source = document.lineAt(line).text;
        // Bound pathological lines while keeping the actual match in view.
        const offset = line === target ? Math.max(0, (range?.start.character ?? 0) - 1000) : 0;
        const prefix = offset ? '…' : '';
        const text = prefix + source.slice(offset, offset + 4000) + (source.length > offset + 4000 ? '…' : '');

        truncated ||= offset > 0 || source.length > offset + 4000;
        if (line === target) {
            const startColumn = Math.max(0, (range?.start.character ?? 0) - offset) + prefix.length;
            const endColumn = range?.end.line === target ? range.end.character - offset + prefix.length : text.length;

            highlightStart = length + Math.min(text.length, startColumn);
            highlightEnd = length + Math.max(startColumn, Math.min(text.length, endColumn));
        }

        lines.push(text);
        length += text.length + 1;
    }

    const code = lines.join('\n');

    if (code.includes('\0')) {
        return { path, message: 'No text preview is available for this file. Press Enter to open it.' };
    }

    const aliases: Record<string, string> = { javascriptreact: 'javascript', typescriptreact: 'typescript', shellscript: 'bash', html: 'xml', c: 'cpp' };
    const language = aliases[document.languageId] ?? document.languageId;
    const html = hljs.getLanguage(language)
        ? hljs.highlight(code, { language, ignoreIllegals: true }).value
        : code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return { path, language: document.languageId, firstLine: first + 1, lineCount: lines.length, targetLine: target + 1, html, highlightStart, highlightEnd, truncated };
}
