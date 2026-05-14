import * as vscode from 'vscode';
import { ContinuesCli } from './ContinuesCli.js';
import { ContinuesViewProvider } from './ContinuesViewProvider.js';

export function activate(context: vscode.ExtensionContext): void {
  const cli = new ContinuesCli();
  const provider = new ContinuesViewProvider(context, cli);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ContinuesViewProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
    vscode.commands.registerCommand('continuesRelay.refreshSessions', () => provider.refreshSessions(true)),
    vscode.commands.registerCommand('continuesRelay.previewHandoff', () => provider.previewSelected()),
    vscode.commands.registerCommand('continuesRelay.resumeInCodex', () => provider.resumeSelected('codex')),
    vscode.commands.registerCommand('continuesRelay.resumeInClaude', () => provider.resumeSelected('claude')),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('continuesRelay')) {
        provider.refreshConfiguration();
      }
    }),
  );
}

export function deactivate(): void {
  return;
}
