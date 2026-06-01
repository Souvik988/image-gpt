import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ExtensionRelayClient } from '../relay/relayClient.js';
import type { Request } from '@kiro-gpt-bridge/shared';

/**
 * Register the kiroGptBridge.generateImage command.
 *
 * R12.6: Prompt user for image description 1–1000 chars; submit `image` request within 1 s.
 * R12.7: On cancel or empty/whitespace, abort silently.
 * R17.2/R17.3: Validate prompt 1–4000 chars in image mode; out-of-range → inline error.
 */
export function registerGenerateImageCommand(
  relayClient: ExtensionRelayClient,
  getActiveSessionId: () => string,
): vscode.Disposable {
  return vscode.commands.registerCommand('kiroGptBridge.generateImage', async () => {
    const prompt = await vscode.window.showInputBox({
      prompt: 'Describe the image you want to generate',
      placeHolder: 'e.g., a futuristic dashboard with holographic charts',
      validateInput: (input) => {
        const trimmed = input.trim();
        if (trimmed.length === 0) return 'Description cannot be empty';
        if (trimmed.length > 1000) return 'Description must be ≤ 1000 characters (use the panel for longer prompts)';
        return null;
      },
    });
    if (prompt === undefined) return; // user cancelled — silent abort
    const trimmed = prompt.trim();
    if (trimmed.length === 0) return; // empty/whitespace — silent abort
    if (trimmed.length > 4000) {
      await vscode.window.showErrorMessage('Image prompt exceeds 4000 characters.');
      return;
    }
    const request: Request = {
      protocolVersion: 1,
      requestId: randomUUID(),
      clientId: relayClient.clientId() ?? 'pending',
      sessionId: getActiveSessionId(),
      type: 'image',
      prompt: trimmed,
      submittedAt: Date.now(),
      // R30.8 / R31.6 / R32.3 — the `kiroGptBridge.generateImage`
      // command is exposed through the in-IDE command palette, which
      // is part of the panel-driven UX surface. Tag every Request from
      // this entry point as `'panel'` so the relay-server logger
      // attributes its lifecycle events to the panel origin.
      origin: 'panel',
    };
    relayClient.submit(request);
  });
}
