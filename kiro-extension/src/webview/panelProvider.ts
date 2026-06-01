/**
 * @file `webview/panelProvider.ts` — sidebar `WebviewViewProvider` for the
 * KIRO Extension's ChatGPT Bridge panel.
 *
 * Owns the two-way bridge between the static webview shell
 * (`webview/ui/panel.{html,css,js}`, task 18.2) and the host-side
 * services: the relay client (task 17.x), the session store (task 15.x),
 * the code-context resolver (task 14.x), and the workspace save flows
 * (task 19.x).
 *
 * Implements:
 *  - R12.1 — sidebar webview titled "ChatGPT Bridge", view id
 *    `kiroGptBridge.panel`.
 *  - R12.3 — singleton panel: VS Code's view registry registers the
 *    `viewType` exactly once, so {@link ChatGptPanelProvider.reveal}
 *    can be invoked any number of times without producing duplicates.
 *  - R13.6 / R13.7 / R13.8 — Copy-to-clipboard, Insert-at-cursor, and
 *    paste-into-editor wiring for fenced code blocks.
 *  - R15.6 / R15.7 — new / delete session controls (delete requires the
 *    webview's confirmed flag).
 *  - R20.2 — single forward of a `request.cancel` to the relay; the
 *    webview disables its Stop button immediately on click so a
 *    double-click cannot send a duplicate.
 *  - R22.1 — panel header status with agent-count and queue-depth
 *    derived from the relay's `server.status` and connection events.
 *
 * Host side-effects (filesystem, prompts, clipboard, editor) are
 * confined to thin adapters in this module so the rest of the
 * extension stays I/O-free and unit-testable.
 */

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { ExtensionRelayClient } from '../relay/relayClient.js';
import { createInflightWatchdog, type InflightWatchdog } from '../relay/inflight.js';
import { SessionStore } from '../sessions/store.js';
import { createSession, appendMessage, takeRecentMessages } from '../sessions/session.js';
import { resolveCodeContext } from '../codeContext/resolver.js';
import { truncateCodeContext } from '../codeContext/truncator.js';
import { saveMarkdown } from '../files/saveMarkdown.js';
import {
  parseWebviewMessage,
  type WebviewToHost,
  type HostToWebview,
  type PanelStatus,
} from './messageBridge.js';
import type {
  Request,
  RequestId,
  SessionId,
  RequestStatusEvent,
} from '@kiro-gpt-bridge/shared';

// ─── Construction options ─────────────────────────────────────────────────

/**
 * Construction options for {@link ChatGptPanelProvider}. Every external
 * collaborator is injected so the provider stays unit-testable.
 */
export interface ChatGptPanelProviderOptions {
  /** Extension URI, used to resolve `src/webview/ui/*` resource paths. */
  extensionUri: vscode.Uri;
  /** Relay client used to submit requests, cancel, and receive stream events. */
  relayClient: ExtensionRelayClient;
  /** Persistent session store backing the conversation thread list. */
  sessionStore: SessionStore;
  /**
   * Default session-history maxN per R15.4. Read from the user setting
   * `kiroGptBridge.sessionHistoryMax`. Invoked on every submit so a
   * settings change takes effect on the next request.
   */
  sessionHistoryMax: () => number;
  /**
   * Workspace-root provider — returns the first workspace folder's
   * absolute path or `null` when no folder is open. Threaded in so the
   * provider does not have to import VS Code's workspace API directly
   * during testing.
   */
  workspaceRoot: () => string | null;
}

// ─── Provider ─────────────────────────────────────────────────────────────

/**
 * Sidebar `WebviewViewProvider` for the ChatGPT Bridge panel.
 *
 * Owned by `extension.ts` (task 19.8); registered once with
 * `vscode.window.registerWebviewViewProvider(ChatGptPanelProvider.viewType, ...)`.
 * The view id and title are fixed (R12.1) and the registry guarantees
 * a single registration per extension activation, which is what makes
 * {@link reveal} idempotent (R12.3).
 *
 * Implements R12.1, R13.6, R13.7, R13.8, R15.6, R15.7, R20.2, R22.1.
 */
export class ChatGptPanelProvider implements vscode.WebviewViewProvider {
  /** Static view id; matches the contribution in `package.json`. */
  public static readonly viewType = 'kiroGptBridge.panel';

  /** Live `WebviewView` once `resolveWebviewView` has been called. */
  private view: vscode.WebviewView | null = null;

  /** Conversation thread the panel is currently focused on. */
  private activeSessionId: SessionId | null = null;

  /**
   * Bookkeeping of in-flight submissions. Keyed by `requestId`, the
   * value is the originating sessionId. Used so a late `stream.chunk`
   * arriving after a session change still routes back to the right
   * thread for persistence.
   */
  private readonly inflightStopMessages = new Map<RequestId, SessionId>();

  /**
   * 30 s no-chunk watchdog (R16.6). Flips a streaming record into
   * `'cancelling'` and posts a `stream.interrupted` frame to the
   * webview so the message header shows "stream interrupted" rather
   * than spinning forever. Lazily created in
   * {@link resolveWebviewView} so tests can construct the provider
   * without starting a real timer.
   */
  private inflightWatchdog: InflightWatchdog | null = null;

  /**
   * @param opts See {@link ChatGptPanelProviderOptions}.
   */
  public constructor(private readonly opts: ChatGptPanelProviderOptions) {
    // Wire relay events → webview. Each subscription is best-effort:
    // listener errors are swallowed by the relay client itself so a
    // faulty webview never crashes the relay event loop.
    opts.relayClient.onConnectionChange((connected) =>
      this.postStatus(connected ? 'connected' : 'disconnected'),
    );
    opts.relayClient.onStreamChunk((chunk) =>
      this.postToWebview({
        kind: 'stream.chunk',
        requestId: chunk.requestId,
        text: chunk.text,
        chunkIndex: chunk.chunkIndex,
        isFinal: chunk.isFinal,
        ...(chunk.mediaType !== undefined ? { mediaType: chunk.mediaType } : {}),
        ...(chunk.base64 !== undefined ? { base64: chunk.base64 } : {}),
      }),
    );
    opts.relayClient.onRequestStatus((event) => this.relayRequestStatus(event));
    opts.relayClient.onAgentStatus((event) =>
      this.postToWebview({
        kind: 'agent.status',
        agentId: event.agentId,
        status: event.status,
        ...(event.message !== undefined ? { message: event.message } : {}),
      }),
    );
    opts.relayClient.onServerStatus((event) =>
      this.postStatus('connected', event.registeredAgents, event.queueDepth),
    );
  }

  // ─── WebviewViewProvider entry point ────────────────────────────────────

  /**
   * VS Code's `WebviewViewProvider` entry point. Invoked exactly once
   * by VS Code when the sidebar view first becomes visible. Wires the
   * HTML body, enables scripts, locks resource loading to the panel UI
   * directory, and attaches the `onDidReceiveMessage` listener.
   */
  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.title = 'ChatGPT Bridge';
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.opts.extensionUri, 'src', 'webview', 'ui'),
      ],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      const msg = parseWebviewMessage(raw);
      if (msg !== null) this.handleWebviewMessage(msg);
    });
    // R16.6: start the 30 s no-chunk watchdog now that the webview is
    // live. Idempotent — only the first resolveWebviewView call wires
    // the timer; subsequent reveals reuse the same instance.
    if (this.inflightWatchdog === null) {
      this.inflightWatchdog = createInflightWatchdog({
        inflight: this.opts.relayClient.getInflightMap(),
        onInterrupt: (requestId) =>
          this.postToWebview({ kind: 'stream.interrupted', requestId }),
      });
    }
    // Restore last session or create a fresh one (R15.6 / R15.7).
    void this.restoreOrCreateInitialSession();
  }

  /**
   * Reveal the panel and (if first invocation) trigger VS Code to call
   * {@link resolveWebviewView}. Implements R12.2 (reveal within 1 s of
   * invocation) and R12.3 (idempotence — repeated calls focus the
   * single existing view rather than creating a duplicate).
   */
  public async reveal(): Promise<void> {
    if (this.view !== null) {
      // preserveFocus = true: surface the view without stealing focus
      // from the active editor. The user can click the panel to focus it.
      this.view.show?.(true);
      return;
    }
    await vscode.commands.executeCommand(
      `workbench.view.extension.${ChatGptPanelProvider.viewType}`,
    );
  }

  // ─── Webview message dispatch ───────────────────────────────────────────

  /**
   * Top-level `WebviewToHost` switch. Each branch delegates to a
   * dedicated method so the dispatch table reads as a single page.
   */
  private handleWebviewMessage(msg: WebviewToHost): void {
    switch (msg.kind) {
      case 'submit':
        void this.onSubmit(msg);
        return;
      case 'cancel':
        // R20.2: forward exactly one cancel; the webview has already
        // disabled its Stop button so a double-click cannot duplicate.
        this.opts.relayClient.cancel(msg.requestId);
        return;
      case 'newSession':
        void this.onNewSession();
        return;
      case 'deleteSession':
        void this.onDeleteSession(msg.sessionId, msg.confirmed);
        return;
      case 'saveMarkdown':
        void this.onSaveMarkdown(msg.messageId, msg.defaultName);
        return;
      case 'saveImage':
        void this.onSaveImage(msg.messageId, msg.defaultName);
        return;
      case 'copyCode':
        // R13.7: copy raw code to clipboard. Transient confirmation is
        // rendered inside the webview by `flashButton` in panel.js.
        void vscode.env.clipboard.writeText(msg.code);
        return;
      case 'insertCode':
        // R13.8: insert at cursor; if no editor is active, surface an
        // error and do NOT modify any file.
        void this.onInsertCode(msg.code);
        return;
    }
  }

  // ─── Submit flow ────────────────────────────────────────────────────────

  /**
   * Build a {@link Request} from a `submit` payload, persist the user
   * message to the active session, and forward to the relay. Resolves
   * `#File:` / `#Folder:` tokens via {@link resolveCodeContext} and
   * enforces the R14.4 200 KB cap via {@link truncateCodeContext}; on
   * any resolution error, surfaces an error in the panel and does NOT
   * forward the request (R14.3).
   */
  private async onSubmit(
    msg: Extract<WebviewToHost, { kind: 'submit' }>,
  ): Promise<void> {
    if (this.activeSessionId === null) {
      await this.onNewSession();
    }
    const sessionId = this.activeSessionId as SessionId;
    let session = this.opts.sessionStore.get(sessionId);
    if (session === undefined) {
      // Edge case: cache miss. Mint a fresh session but keep the id
      // stable so the webview's notion of `activeSessionId` still
      // matches the on-disk record.
      const fresh = createSession();
      session = { ...fresh, sessionId };
    }

    // Resolve #File / #Folder tokens, then enforce the R14.4 200 KB cap.
    let promptText = msg.text;
    let codeContextTruncated:
      | { originalSizeBytes: number; truncatedToBytes: number }
      | undefined;
    if (msg.codeContextTokens.length > 0) {
      const ws = this.opts.workspaceRoot();
      if (ws !== null) {
        const resolved = resolveCodeContext(promptText, ws);
        if (resolved.errors.length > 0) {
          // R14.3: any error MUST cause the caller to refuse to send.
          const summary = resolved.errors
            .map((e) => `${e.token} (${e.reason})`)
            .join('; ');
          this.postError(`Code-context resolution failed: ${summary}`);
          return;
        }
        const truncResult = truncateCodeContext(resolved.text);
        promptText = truncResult.text;
        if (truncResult.truncated) {
          codeContextTruncated = {
            originalSizeBytes: truncResult.originalSizeBytes,
            truncatedToBytes: truncResult.truncatedToBytes,
          };
        }
      }
    }

    // Append user message to the session BEFORE building the wire request
    // so a crash mid-submit still leaves the user message on disk.
    session = appendMessage(session, { role: 'user', text: promptText });

    // Build the wire request.
    const requestId: RequestId = randomUUID();
    const historyN = this.opts.sessionHistoryMax();
    const recent = takeRecentMessages(session, historyN).map(
      (m): { role: 'user' | 'assistant'; text: string; createdAt: number } => ({
        role: m.role,
        text: m.text ?? '',
        createdAt: m.createdAt,
      }),
    );
    const request: Request = {
      protocolVersion: 1,
      requestId,
      clientId: this.opts.relayClient.clientId() ?? 'pending',
      sessionId,
      type: msg.mode,
      prompt: promptText,
      ...(codeContextTruncated !== undefined
        ? { codeContext: { truncated: codeContextTruncated } }
        : {}),
      ...(recent.length > 0 ? { history: recent } : {}),
      ...(msg.attachments.length > 0
        ? {
            // Task 19.7 wires the actual base64 payload through the
            // attachments command; until then the chip metadata is
            // forwarded with an empty payload so the wire shape
            // typechecks and the build proceeds.
            attachments: msg.attachments.map((a) => ({
              filename: a.filename,
              mimeType: a.mimeType,
              base64: '',
            })),
          }
        : {}),
      submittedAt: Date.now(),
      // R30.8 / R31.6 / R32.3 — tag every panel-driven Request so the
      // relay-server logger emits `origin: "panel"` on every lifecycle
      // entry for this Request.
      origin: 'panel',
    };

    // Persist and submit. `save` is fire-and-forget — its retry policy
    // and toast hook are documented in `sessions/store.ts`.
    void this.opts.sessionStore.save(session);
    this.inflightStopMessages.set(requestId, sessionId);

    this.opts.relayClient.submit(request);
  }

  // ─── Status / lifecycle relays ──────────────────────────────────────────

  /**
   * Relay a `request.status` event into the webview's per-message
   * lifecycle UI. The webview only cares about `queued` and
   * `dispatched`; later states (streaming, terminal) ride in via
   * `stream.chunk` / `request.terminal` and `agent.status` events.
   */
  private relayRequestStatus(event: RequestStatusEvent): void {
    if (event.status === 'queued') {
      this.postToWebview({
        kind: 'request.queued',
        requestId: event.requestId,
        queuePosition: event.queuePosition ?? 0,
      });
    } else if (event.status === 'dispatched') {
      this.postToWebview({
        kind: 'request.dispatched',
        requestId: event.requestId,
        agentId: event.agentId ?? '',
      });
    }
  }

  // ─── Session controls ───────────────────────────────────────────────────

  /**
   * On panel boot, restore the most-recently-updated session if one
   * exists; otherwise create a fresh session so the panel is always
   * usable. Implements R15.6 / R15.7.
   */
  private async restoreOrCreateInitialSession(): Promise<void> {
    const sessions = this.opts.sessionStore.list();
    if (sessions.length > 0) {
      const latest = sessions.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
      this.activeSessionId = latest.sessionId;
      this.postToWebview({ kind: 'session.loaded', session: latest });
      return;
    }
    await this.onNewSession();
  }

  /**
   * Create a fresh session, persist it, and notify the webview.
   * Implements R15.6.
   */
  private async onNewSession(): Promise<void> {
    const session = createSession();
    this.activeSessionId = session.sessionId;
    await this.opts.sessionStore.save(session);
    this.postToWebview({ kind: 'session.created', sessionId: session.sessionId });
  }

  /**
   * Delete a session iff `confirmed` is true. If the deleted session
   * was the active one, immediately mint a replacement so the panel
   * stays usable. Implements R15.7.
   */
  private async onDeleteSession(
    sessionId: SessionId,
    confirmed: boolean,
  ): Promise<void> {
    if (!confirmed) return;
    await this.opts.sessionStore.delete(sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
      await this.onNewSession();
    }
  }

  // ─── Save actions ───────────────────────────────────────────────────────

  /**
   * Save a final assistant text message as a markdown file under the
   * workspace root. Looks up the message text in the active session
   * by `messageId`; the session has already been persisted so the
   * message is available in the cache. Delegates to {@link saveMarkdown}
   * for the actual prompt + write flow (R19.1–R19.6).
   */
  private async onSaveMarkdown(
    messageId: string,
    defaultName: string,
  ): Promise<void> {
    const sessionId = this.activeSessionId;
    if (sessionId === null) {
      this.postError('No active session');
      return;
    }
    const session = this.opts.sessionStore.get(sessionId);
    const message = session?.messages.find((m) => m.id === messageId);
    if (message === undefined || message.text === undefined) {
      this.postError('Message not found or has no text content');
      return;
    }
    await saveMarkdown(
      { text: message.text, defaultName },
      {
        workspaceRoot: this.opts.workspaceRoot(),
        promptFilename: async (def) =>
          vscode.window.showInputBox({ value: def, prompt: 'Save as' }),
        promptOverwrite: async (target) => {
          const choice = await vscode.window.showWarningMessage(
            `Overwrite ${path.basename(target)}?`,
            { modal: true },
            'Overwrite',
            'Cancel',
          );
          if (choice === 'Overwrite') return 'overwrite';
          if (choice === 'Cancel') return 'cancel';
          return undefined;
        },
        showError: (m) => {
          void vscode.window.showErrorMessage(m);
        },
        showInfo: (m) => {
          void vscode.window.showInformationMessage(m);
        },
        fs: {
          exists: async (p) => {
            try {
              await vscode.workspace.fs.stat(vscode.Uri.file(p));
              return true;
            } catch {
              return false;
            }
          },
          mkdir: async (p) => {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(p));
          },
          writeFile: async (p, data) => {
            await vscode.workspace.fs.writeFile(
              vscode.Uri.file(p),
              Buffer.from(data, 'utf8'),
            );
          },
          rename: async (from, to) => {
            await vscode.workspace.fs.rename(
              vscode.Uri.file(from),
              vscode.Uri.file(to),
            );
          },
          unlink: async (p) => {
            await vscode.workspace.fs.delete(vscode.Uri.file(p));
          },
        },
      },
    );
  }

  /**
   * Save a final assistant image message to the workspace root. The
   * webview already renders the image inline from the `stream.chunk`
   * payload, but the base64 bytes are not currently persisted with
   * the {@link import('@kiro-gpt-bridge/shared').Session} record. Task
   * 19.3 wires base64 retention into the session store and the matching
   * call into {@link import('../files/saveImage.js').saveImage} here;
   * for now the host surfaces a friendly error so the user understands
   * why the action did not produce a file.
   */
  private async onSaveImage(
    messageId: string,
    defaultName: string,
  ): Promise<void> {
    const sessionId = this.activeSessionId;
    if (sessionId === null) {
      this.postError('No active session');
      return;
    }
    const session = this.opts.sessionStore.get(sessionId);
    const message = session?.messages.find((m) => m.id === messageId);
    if (message === undefined || message.mediaType === undefined) {
      this.postError('Message not found or has no image');
      return;
    }
    this.postError(
      'Image save requires session persistence of base64 (task 19.3)',
    );
    // `defaultName` will be honoured once task 19.3 wires base64 retention.
    void defaultName;
  }

  // ─── Insert code at cursor ──────────────────────────────────────────────

  /**
   * Insert `code` at the active editor's cursor position. R13.8 — if
   * no editor is active, surfaces an error in the panel and does NOT
   * modify any file.
   */
  private async onInsertCode(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      this.postError('No active editor — open a file first');
      return;
    }
    await editor.edit((edit) => edit.insert(editor.selection.active, code));
  }

  // ─── Webview helpers ────────────────────────────────────────────────────

  /**
   * Post a typed {@link HostToWebview} message to the live webview.
   * No-op when the view has not yet been resolved.
   */
  private postToWebview(msg: HostToWebview): void {
    if (this.view === null) return;
    void this.view.webview.postMessage(msg);
  }

  /**
   * Post a `status` frame to the webview. R22.1 — the panel header
   * renders `panelStatus`, `agents`, and `queue` from this single
   * message.
   */
  private postStatus(
    panelStatus: PanelStatus,
    agents: number = 0,
    queue: number = 0,
  ): void {
    this.postToWebview({ kind: 'status', panelStatus, agents, queue });
  }

  /** Post an `error` frame the webview will render in its composer banner. */
  private postError(message: string): void {
    this.postToWebview({ kind: 'error', message });
  }

  /**
   * Stop the inflight watchdog. Idempotent. Called from the
   * `extension.ts` cleanup disposable so the timer does not leak when
   * VS Code deactivates the extension.
   */
  public dispose(): void {
    if (this.inflightWatchdog !== null) {
      this.inflightWatchdog.dispose();
      this.inflightWatchdog = null;
    }
  }

  /**
   * Read `panel.html` from disk and substitute the `${cspSource}`,
   * `${cssUri}`, and `${jsUri}` placeholders with `webview.cspSource`
   * and `webview.asWebviewUri(...)` results respectively. Synchronous
   * read is acceptable here because `resolveWebviewView` is invoked
   * once per panel and the file is small (a few KB).
   */
  private buildHtml(webview: vscode.Webview): string {
    const uiDir = vscode.Uri.joinPath(
      this.opts.extensionUri,
      'src',
      'webview',
      'ui',
    );
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(uiDir, 'panel.css')).toString();
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(uiDir, 'panel.js')).toString();
    const cspSource = webview.cspSource;
    const htmlPath = path.join(
      this.opts.extensionUri.fsPath,
      'src',
      'webview',
      'ui',
      'panel.html',
    );
    let html: string;
    try {
      html = fs.readFileSync(htmlPath, 'utf8');
    } catch {
      // Fallback: minimal inline shell so the panel does not go blank
      // if `panel.html` is missing from the packaged extension.
      html =
        '<!DOCTYPE html><html><body><h2>ChatGPT Bridge</h2>' +
        '<p>Failed to load panel.html</p></body></html>';
    }
    return html
      .replaceAll('${cspSource}', cspSource)
      .replaceAll('${cssUri}', cssUri)
      .replaceAll('${jsUri}', jsUri);
  }
}
