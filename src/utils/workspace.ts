import * as vscode from 'vscode';

/**
 * Check whether a URI belongs to one of the currently opened workspace folders.
 */
export function isWorkspaceFile(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file') {
        return false;
    }

    return vscode.workspace.getWorkspaceFolder(uri) !== undefined;
}
