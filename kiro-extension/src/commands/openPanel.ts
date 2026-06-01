import * as vscode from 'vscode';
import { ChatGptPanelProvider } from '../webview/panelProvider.js';

/**
 * Register and return the openPanel command.
 *
 * R12.2: Reveal the existing panel within 1 s of invocation.
 * R12.3: Idempotent — invoking while panel is already visible just focuses it,
 *        does NOT create a duplicate. The provider is a singleton, so vscode's
 *        view registry naturally enforces this.
 */
export function registerOpenPanelCommand(provider: ChatGptPanelProvider): vscode.Disposable {
  return vscode.commands.registerCommand('kiroGptBridge.openPanel', async () => {
    await provider.reveal();
  });
}
