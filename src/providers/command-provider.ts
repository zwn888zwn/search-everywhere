import * as vscode from 'vscode';
import { CommandSearchItem, SearchItemType, SearchProvider } from '../core/types';

interface CommandContribution {
    command: string;
    title: unknown;
    category?: unknown;
}

/** Provides user-facing VS Code actions as a Search Everywhere contributor. */
export class CommandSearchProvider implements SearchProvider {
    public async getItems(): Promise<CommandSearchItem[]> {
        const availableCommands = new Set(await vscode.commands.getCommands(true));
        const labels = this.getContributedCommandLabels();
        const items: CommandSearchItem[] = [];

        for (const command of availableCommands) {
            if (command.startsWith('_')) {
                continue;
            }

            const contributed = labels.get(command);

            if (!contributed && this.isInternalCommand(command)) {
                continue;
            }

            const label = contributed?.label || this.formatCommandName(command);
            const description = contributed?.category || 'Action';

            items.push({
                id: `command:${command}`,
                label,
                description,
                detail: command,
                type: SearchItemType.Command,
                command,
                priority: 20,
                iconPath: new vscode.ThemeIcon('run'),
                action: async () => {
                    await vscode.commands.executeCommand(command);
                }
            });
        }

        return items;
    }

    public async refresh(): Promise<void> {}

    private getContributedCommandLabels(): Map<string, { label: string; category?: string }> {
        const labels = new Map<string, { label: string; category?: string }>();

        for (const extension of vscode.extensions.all) {
            const contributions = extension.packageJSON?.contributes?.commands as CommandContribution[] | undefined;

            for (const contribution of contributions || []) {
                const title = this.getContributionText(contribution.title);
                const category = this.getContributionText(contribution.category);

                if (contribution.command && title) {
                    labels.set(contribution.command, {
                        label: title,
                        category
                    });
                }
            }
        }

        return labels;
    }

    private getContributionText(value: unknown): string | undefined {
        if (typeof value === 'string') {
            return value;
        }

        if (value && typeof value === 'object') {
            const localizedValue = (value as { value?: unknown }).value;

            return typeof localizedValue === 'string' ? localizedValue : undefined;
        }

        return undefined;
    }

    private isInternalCommand(command: string): boolean {
        return command.startsWith('vscode.') ||
            command.startsWith('workbench.') ||
            command.startsWith('editor.') ||
            command.includes('.');
    }

    private formatCommandName(command: string): string {
        return command
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, character => character.toUpperCase());
    }
}
