import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ExtensionRelayClient } from '../relay/relayClient.js';
import type { ChatGptPanelProvider } from '../webview/panelProvider.js';
import type {
  Request,
  CodeContext,
  SessionId,
} from '@kiro-gpt-bridge/shared';

/**
 * Mapping from VS Code command id to the natural-language prefix prepended
 * to the user's selected code (or whole file) before submission. R13.1 —
 * the six command ids registered here are exactly those the requirement
 * names. R13.3 — the `codeContext` payload (assembled in
 * {@link handleCommand}) carries selection / filePath / language so the
 * agent has the prompt + context the user expects.
 */
const COMMAND_PROMPTS: Record<string, string> = {
  'kiroGptBridge.explainCode': 'Explain the following code:',
  'kiroGptBridge.refactorCode':
    'Refactor the following code, explaining your changes:',
  'kiroGptBridge.generateTests':
    'Generate unit tests for the following code:',
  'kiroGptBridge.documentCode':
    'Add documentation comments to the following code:',
  'kiroGptBridge.findBugs': 'Find potential bugs in the following code:',
  'kiroGptBridge.optimizeCode':
    'Suggest optimizations for the following code:',
};

/**
 * Lower bound on a non-empty selection. R13.2 mandates the selection
 * range 1..100000 chars for the right-click context menu.
 */
const SELECTION_MIN = 1;

/**
 * Upper bound on a non-empty selection for every command except
 * `explainCode`. R13.2.
 */
const SELECTION_MAX = 100_000;

/**
 * Tighter cap that R12.4 / R12.5 impose on `kiroGptBridge.explainCode`:
 * selections must lie in 1..10000 chars or the command surfaces an error
 * and aborts without submitting.
 */
const EXPLAIN_SELECTION_MAX = 10_000;

/**
 * Whole-file fallback ceiling per R13.5: when the command runs without
 * an active selection, the entire file content is included up to this
 * number of characters.
 */
const FILE_CONTENT_MAX = 200_000;

/**
 * Register all six code-aware editor commands. Implements R12.4
 * (`explainCode` reveals the panel and submits within 1 s of invocation),
 * R12.5 (`explainCode` rejects selections outside 1..10000 chars), R13.1
 * (the six commands are registered), R13.2 (selection range gate
 * 1..100000), R13.3 (codeContext carries selection/filePath/language),
 * R13.4 (missing filePath or language blocks submission with an error),
 * and R13.5 (no selection ⇒ whole-file content up to 200000 chars).
 *
 * @param relayClient        Connected relay client used to submit the
 *                           assembled Request.
 * @param panelProvider      Sidebar panel; revealed before submit so the
 *                           streaming response is visible to the user.
 * @param getActiveSessionId Resolver for the current conversation thread
 *                           id; the extension owns session lifecycle
 *                           outside this module.
 * @returns A list of disposables — one per registered command — for the
 *          extension host to track in its activation context.
 */
export function registerCodeAwareCommands(
  relayClient: ExtensionRelayClient,
  panelProvider: ChatGptPanelProvider,
  getActiveSessionId: () => SessionId,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  for (const commandId of Object.keys(COMMAND_PROMPTS)) {
    disposables.push(
      vscode.commands.registerCommand(commandId, async () => {
        await handleCommand(
          commandId,
          relayClient,
          panelProvider,
          getActiveSessionId,
        );
      }),
    );
  }
  return disposables;
}

/**
 * Shared body for every code-aware command. Resolves the active editor,
 * validates filePath + language (R13.4), enforces the selection-length
 * bounds (R13.2 / R12.5), falls back to whole-file content when there is
 * no selection (R13.5), assembles the Request with a populated
 * {@link CodeContext} (R13.3), reveals the panel, and forwards the
 * Request to the relay (R12.4).
 *
 * Errors are surfaced via `vscode.window.showErrorMessage` and the
 * function returns without submitting; this matches R12.5 / R13.4 which
 * both forbid sending a Request when validation fails.
 */
async function handleCommand(
  commandId: string,
  relayClient: ExtensionRelayClient,
  panelProvider: ChatGptPanelProvider,
  getActiveSessionId: () => SessionId,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    await vscode.window.showErrorMessage(
      `Cannot run ${commandId}: no active editor`,
    );
    return;
  }

  const filePath = editor.document.uri.fsPath;
  const language = editor.document.languageId;
  // R13.4: filePath or language unknown — block, surface error, do not send.
  if (filePath === '' || language === '' || language === 'plaintext') {
    const missing = filePath === '' ? 'file path' : 'language';
    await vscode.window.showErrorMessage(
      `Cannot run ${commandId}: ${missing} cannot be determined`,
    );
    return;
  }

  // Determine selection or whole-file fallback (R13.2 / R13.5).
  const selection = editor.selection;
  let snippet: string;
  let codeContext: CodeContext;
  if (!selection.isEmpty) {
    snippet = editor.document.getText(selection);
    if (snippet.length < SELECTION_MIN || snippet.length > SELECTION_MAX) {
      await vscode.window.showErrorMessage(
        `Cannot run ${commandId}: selection length ${snippet.length} is outside [${SELECTION_MIN}, ${SELECTION_MAX}]`,
      );
      return;
    }
    // R12.5: explainCode tightens the upper bound to 10000 chars.
    if (
      commandId === 'kiroGptBridge.explainCode' &&
      snippet.length > EXPLAIN_SELECTION_MAX
    ) {
      await vscode.window.showErrorMessage(
        `Cannot run ${commandId}: selection length ${snippet.length} exceeds ${EXPLAIN_SELECTION_MAX} characters`,
      );
      return;
    }
    codeContext = { selection: snippet, filePath, language };
  } else {
    // R13.5: no selection ⇒ include the whole active file, up to the cap.
    const fullText = editor.document.getText();
    if (fullText.length === 0) {
      await vscode.window.showErrorMessage(
        `Cannot run ${commandId}: active file is empty`,
      );
      return;
    }
    snippet =
      fullText.length > FILE_CONTENT_MAX
        ? fullText.slice(0, FILE_CONTENT_MAX)
        : fullText;
    codeContext = { fileContent: snippet, filePath, language };
  }

  const promptHeader =
    COMMAND_PROMPTS[commandId] ?? 'Process the following code:';
  const promptText = `${promptHeader}\n\n\`\`\`${language}\n${snippet}\n\`\`\``;

  const request: Request = {
    protocolVersion: 1,
    requestId: randomUUID(),
    clientId: relayClient.clientId() ?? 'pending',
    sessionId: getActiveSessionId(),
    type: 'chat',
    prompt: promptText,
    codeContext,
    submittedAt: Date.now(),
    // R30.8 / R31.6 / R32.3 — code-aware commands (Explain Selection,
    // Improve Selection, etc.) are panel-driven entry points: they
    // reveal the panel before submitting (see below) and surface their
    // streaming response in the panel's UI. Tag the Request as
    // `'panel'` so the relay-server logger attributes its lifecycle
    // events accordingly.
    origin: 'panel',
  };

  // R12.4: reveal panel before submit so the streaming response is visible
  // within the 1 s budget. `panelProvider.reveal()` is idempotent (R12.3).
  await panelProvider.reveal();
  relayClient.submit(request);
}
