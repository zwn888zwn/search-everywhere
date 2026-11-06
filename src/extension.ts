// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { SearchService } from './core/search-service';
import { SearchUI } from './ui/search-ui';
import { SearchPanel } from './ui/search-panel';
import Logger from './utils/logging';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	Logger.initialize();
	Logger.debug('Search Everywhere extension activated');

	console.log('Activating Search Everywhere extension...');

	// Create the search service
	const searchService = new SearchService(context);

	// Start restoring the persisted file/action index before the user opens
	// Search Everywhere, so the first query does not pay the cache-load cost.
	searchService.startIndexing();

	// Create the search UI
	const searchPanel = new SearchPanel(searchService, context);
	let searchUI: SearchUI | undefined;

	// Register search command
	const searchDisposable = vscode.commands.registerCommand('search-everywhere.search', () => {
		searchPanel.show();
	});
	const classicDisposable = vscode.commands.registerCommand('search-everywhere.searchClassic', () => {
		searchPanel.close();
		searchUI ??= new SearchUI(searchService, context);
		searchUI.show();
	});

	// Register rebuild index command
	const rebuildDisposable = vscode.commands.registerCommand('search-everywhere.rebuildIndex', async () => {
		// Show progress notification
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Rebuilding Search Indexes...',
				cancellable: false
			},
			async (progress) => {
				progress.report({ increment: 0 });

				try {
					// Force refresh all indexes
					await searchService.refreshIndex(true);

					// Show success message
					vscode.window.showInformationMessage('Search Everywhere indexes rebuilt successfully!');
				} catch (error) {
					// Show error message
					vscode.window.showErrorMessage(`Failed to rebuild indexes: ${error}`);
				}

				progress.report({ increment: 100 });
			}
		);
	});

	// Add commands to context
	context.subscriptions.push(searchDisposable, classicDisposable, rebuildDisposable, searchPanel);

	console.log('Search Everywhere extension activated');
}

// This method is called when your extension is deactivated
export function deactivate() {
	console.log('Search Everywhere extension deactivated');
}
