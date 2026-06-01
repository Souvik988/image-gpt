/**
 * @file `extension.ts` — VS Code activation entrypoint for the KIRO-GPT
 * Bridge.
 *
 * `activate(ctx)` wires together every host-side collaborator: the
 * relay client (task 17.x), the session store (task 15.x), the sidebar
 * `ChatGptPanelProvider` (task 18.3), the status bar (task 19.6), and
 * the eight user-facing commands (tasks 12.x, 13.x, 19.5). Returns the
 * public extension API surface so other extensions can drive the
 * programmatic image-generation entrypoint via
 * `vscode.extensions.getExtension(...).exports`.
 *
 * Implements:
 *  - R4.1   — connect to the URL from `kiroGptBridge.relayUrl` on activation.
 *  - R4.2   — missing / empty / non-URL `kiroGptBridge.relayUrl` surfaces an
 *             error toast and skips the connection attempt entirely.
 *  - R12.1  — register the `WebviewViewProvider` for the sidebar view id
 *             {@link ChatGptPanelProvider.viewType} ("ChatGPT Bridge").
 *  - R28.2  — the panel is opt-in: it activates on `onStartupFinished`
 *             but only opens a network socket when the user has populated
 *             `kiroGptBridge.relayUrl`.
 *  - R28.6  — when the panel is disabled (no relay URL), the extension
 *             initiates no outbound network connection.
 *  - R29.1 / R29.2 / R29.7 — return a public `KiroGptBridgeApi` from
 *             `activate(...)`. The real `generateImage` body lives in
 *             `src/api/extensionApi.ts` (task 22.5) and is backed by
 *             {@link AssetGenerator}. The early-precondition-failure
 *             paths (R4.2 / R28.6) still return a typed stub via
 *             {@link makeStubApi} so callers always see a structured
 *             `errorCode` instead of a runtime crash.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import { ChatGptPanelProvider } from './webview/panelProvider.js';
import { createRelayClient } from './relay/relayClient.js';
import { SessionStore } from './sessions/store.js';
import { createStatusBar } from './status/statusBar.js';
import { registerOpenPanelCommand } from './commands/openPanel.js';
import { registerGenerateImageCommand } from './commands/generateImage.js';
import { registerCodeAwareCommands } from './commands/codeAwareCommands.js';
import { registerMissingAssetCommands } from './commands/generateMissingAssets.js';
import { AssetGenerator } from './assets/assetGenerator.js';
import {
  MissingAssetCodeLensProvider,
  MISSING_ASSET_DOCUMENT_SELECTOR,
} from './assets/missingAssetCodeLens.js';
import {
  createExtensionApi,
  type GenerateImageOptions,
  type GenerateImageResult,
  type KiroGptBridgeApi,
} from './api/extensionApi.js';
import type { SessionId } from '@kiro-gpt-bridge/shared';

// ─── Constants ─────────────────────────────────────────────────────────────

/**
 * Extension semver advertised in the Socket.IO handshake. Bumped manually
 * here until the build tooling injects the package.json version (task
 * 21.3 / 22.x). Wire-incompatible changes must bump this so the relay
 * can identify mismatched clients in its structured logs.
 */
const PACKAGE_VERSION = '0.0.0';

/**
 * Subdirectory under `context.globalStorageUri.fsPath` where one JSON
 * file per session is persisted. R15.1.
 */
const SESSION_STORAGE_SUBDIR = 'sessions';

/**
 * Default for `kiroGptBridge.sessionHistoryMax` (R15.4). Overridden by
 * the user setting; the schema clamps to 1..200.
 */
const DEFAULT_SESSION_HISTORY_MAX = 50;

/**
 * VS Code status-bar item priority. Higher values appear further left
 * within the right-aligned cluster. Chosen to sit just left of the
 * built-in line/col indicator.
 */
const STATUS_BAR_PRIORITY = 100;

// ─── Public extension API surface ──────────────────────────────────────────

/**
 * Re-export the public extension API types from `./api/extensionApi.js`
 * so consumers can keep importing them from `extension.ts` (the file
 * VS Code resolves as the activation entry-point) without forcing the
 * factory module's path on them. The real definitions — and the
 * accompanying TSDoc citing R29.1 / R29.2 / R29.7 — live alongside the
 * implementation.
 */
export type {
  GenerateImageOptions,
  GenerateImageResult,
  KiroGptBridgeApi,
} from './api/extensionApi.js';

// ─── Module-level state ────────────────────────────────────────────────────

/**
 * Active session id used by the standalone commands (`generateImage`,
 * the six code-aware commands). The panel provider owns its own
 * notion of the active session; the commands read from this shared
 * value so submissions outside the panel land in the same thread the
 * user most recently interacted with. `null` until the panel boots
 * its first session, which is restored or minted during
 * `panelProvider.resolveWebviewView`.
 *
 * The closure captures the current value via getter functions so a
 * later session change is reflected without re-registering commands.
 */
let activeSessionId: SessionId | null = null;
void activeSessionId; // reserved for future panel↔command sync (task 22.x)

// ─── Activation ────────────────────────────────────────────────────────────

/**
 * VS Code activation entrypoint. Runs on `onStartupFinished` per the
 * `activationEvents` declared in `package.json`. Builds every
 * collaborator, registers the WebviewViewProvider and the eight
 * commands, starts the relay client (when configured), and returns
 * the public {@link KiroGptBridgeApi} object.
 *
 * On any precondition failure (R4.2), the function surfaces an error
 * toast, returns a {@link makeStubApi} result, and skips the network
 * connection (R28.6).
 *
 * @param context VS Code-supplied activation context. Consumed for
 *                `subscriptions`, `extensionUri`, and
 *                `globalStorageUri`.
 * @returns The public extension API.
 */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<KiroGptBridgeApi> {
  const config = vscode.workspace.getConfiguration('kiroGptBridge');
  const relayUrl = (config.get<string>('relayUrl') ?? '').trim();
  const sessionHistoryMax =
    config.get<number>('sessionHistoryMax') ?? DEFAULT_SESSION_HISTORY_MAX;

  // R4.2 / R28.6: missing or empty URL → error, no outbound connection.
  if (relayUrl === '') {
    void vscode.window.showErrorMessage(
      'kiroGptBridge.relayUrl is not set. Configure it in settings to connect.',
    );
    return makeStubApi('relayUrl_unset');
  }

  // R4.2: non-URL string → error, no outbound connection.
  try {
    // Constructing throws on malformed input; the value itself is unused.
    new URL(relayUrl);
  } catch (e) {
    void vscode.window.showErrorMessage(
      `kiroGptBridge.relayUrl is not a valid URL: ${(e as Error).message}`,
    );
    return makeStubApi('relayUrl_invalid');
  }

  const kiroSecret = config.get<string>('kiroSecret') ?? '';
  if (kiroSecret.length === 0) {
    void vscode.window.showWarningMessage(
      'kiroGptBridge.kiroSecret is not set. Set it to connect to the relay.',
    );
  }

  // ─── Session store ─────────────────────────────────────────────────────
  const storageDir = path.join(
    context.globalStorageUri.fsPath,
    SESSION_STORAGE_SUBDIR,
  );
  const sessionStore = new SessionStore({
    storageDir,
    onPersistFailure: (sessionId, err) => {
      void vscode.window.showWarningMessage(
        `Failed to persist session ${sessionId}: ${err.message}`,
      );
    },
  });
  await sessionStore.init();

  // ─── Relay client ──────────────────────────────────────────────────────
  const relayClient = createRelayClient({
    relayUrl,
    kiroSecret,
    clientVersion: PACKAGE_VERSION,
  });

  // ─── Panel provider ────────────────────────────────────────────────────
  const workspaceRoot = (): string | null => {
    const folders = vscode.workspace.workspaceFolders;
    if (folders === undefined || folders.length === 0) return null;
    return folders[0]?.uri.fsPath ?? null;
  };
  const panelProvider = new ChatGptPanelProvider({
    extensionUri: context.extensionUri,
    relayClient,
    sessionStore,
    sessionHistoryMax: () => sessionHistoryMax,
    workspaceRoot,
  });

  // ─── Status bar ────────────────────────────────────────────────────────
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    STATUS_BAR_PRIORITY,
  );
  statusBarItem.text = 'GPT: disconnected';
  statusBarItem.command = 'kiroGptBridge.openPanel';
  statusBarItem.show();
  const statusBarMgr = createStatusBar({
    sink: {
      setStatusBarText: (text) => {
        statusBarItem.text = `GPT: ${text}`;
      },
      setHeaderLabel: () => {
        // Webview-side header is rendered by `panelProvider`.
      },
    },
  });
  // Forward connection events into the status-bar state machine. Other
  // status events (agent count, queue depth, request lifecycle) are
  // already wired through `panelProvider`'s relay subscriptions.
  relayClient.onConnectionChange((connected) =>
    statusBarMgr.apply({ kind: 'connection', connected }),
  );

  // ─── Webview registration ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatGptPanelProvider.viewType,
      panelProvider,
    ),
  );

  // ─── Asset generator ───────────────────────────────────────────────────
  // R29.1 / R29.2 / R29.7: the public extension API is a thin facade
  // over `AssetGenerator`. Constructed only on the success path; the
  // R4.2 / R28.6 early-return branches above use {@link makeStubApi}
  // because no relay client exists in those paths.
  //
  // The session-id closure is shared with the standalone commands so
  // `generateImage` calls coming through the public API land in the
  // same session the panel commands write to.
  const sessionIdProvider = (): SessionId =>
    (activeSessionId ?? 'pending') as SessionId;
  const assetGenerator = new AssetGenerator({
    relayClient,
    workspaceRoot,
    activeSessionId: sessionIdProvider,
    notifySaved: (savedPath) => {
      // R29.8 — non-blocking notification with a "Reveal in Explorer"
      // action. The action dispatches the built-in command so the
      // saved file is highlighted in the OS file manager.
      const reveal = 'Reveal in Explorer';
      void vscode.window
        .showInformationMessage(`Image saved: ${savedPath}`, reveal)
        .then((picked) => {
          if (picked === reveal) {
            void vscode.commands.executeCommand(
              'revealFileInOS',
              vscode.Uri.file(savedPath),
            );
          }
        });
    },
  });

  // ─── Missing-asset code lens ───────────────────────────────────────────
  // R30.6: surface a CodeLens on every missing image reference in the
  // supported document languages. The lens dispatches the singular
  // `kiroGptBridge.generateMissingAsset` command registered below.
  const missingAssetCodeLens = new MissingAssetCodeLensProvider({
    workspaceRoot,
  });
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      MISSING_ASSET_DOCUMENT_SELECTOR,
      missingAssetCodeLens,
    ),
    missingAssetCodeLens,
  );

  // ─── Commands ──────────────────────────────────────────────────────────
  // Standalone commands (`generateImage`, six code-aware) need a
  // session id; until the panel provider exposes its `activeSessionId`
  // accessor (task 22.x), they fall back to the literal `'pending'`
  // which is well-formed enough for the relay's idempotency map.
  context.subscriptions.push(
    registerOpenPanelCommand(panelProvider),
    registerGenerateImageCommand(relayClient, sessionIdProvider),
    ...registerCodeAwareCommands(
      relayClient,
      panelProvider,
      sessionIdProvider,
    ),
    // R30.6 / R30.7: missing-asset workflow. Singular command is
    // dispatched by the code lens; plural command is exposed in the
    // command palette and triggered by the `fileEdited` Kiro hook.
    ...registerMissingAssetCommands(assetGenerator, context),
  );

  // ─── Cleanup ───────────────────────────────────────────────────────────
  context.subscriptions.push({
    dispose: () => {
      relayClient.stop();
      statusBarMgr.dispose();
      statusBarItem.dispose();
      sessionStore.dispose();
      panelProvider.dispose();
    },
  });

  // ─── Start relay client ────────────────────────────────────────────────
  // R4.1: fire-and-forget; the panel header reflects connection state.
  // R4.3 retries are owned by `runFirstConnect` inside the relay client.
  void relayClient.start().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Failed to connect to relay: ${message}`);
  });

  return createExtensionApi({ assetGenerator });
}

/**
 * Build a structured stub {@link KiroGptBridgeApi} for the early
 * precondition-failure paths (R4.2 / R28.6). When the user has not set
 * `kiroGptBridge.relayUrl`, or the value is not a valid URL, the
 * extension declines to open a socket — but it still returns a typed
 * API object so other extensions calling `generateImage(...)` get a
 * structured `errorCode` instead of a runtime crash. The non-throwing
 * shape matches R29.7.
 *
 * @param reason Short identifier surfaced via `errorCode` so callers
 *               can distinguish "url missing" from "url invalid".
 * @returns      A typed stub matching {@link KiroGptBridgeApi}.
 */
function makeStubApi(reason: string): KiroGptBridgeApi {
  return {
    async generateImage(opts: GenerateImageOptions): Promise<GenerateImageResult> {
      return {
        requestId: 'stub',
        prompt: opts.prompt,
        errorCode: reason,
        message:
          'KIRO-GPT Bridge is not connected (configure kiroGptBridge.relayUrl).',
      };
    },
  };
}

/**
 * VS Code deactivation hook. The {@link vscode.ExtensionContext}'s
 * `subscriptions` array is disposed automatically by VS Code, so the
 * cleanup disposable pushed in {@link activate} runs without explicit
 * action here.
 */
export function deactivate(): void {
  // Intentional no-op — see TSDoc above.
}
