/**
 * Webview ↔ extension message bridge.
 *
 * Defines the discriminated unions {@link WebviewToHost} and
 * {@link HostToWebview} that flow over `webview.postMessage` /
 * `onDidReceiveMessage` between the KIRO Extension host and the sidebar
 * webview guest, plus the type-safe wrappers
 * {@link postToWebview} and {@link parseWebviewMessage}.
 *
 * Implements R12.1 (panel transport surface) and R20.2 (cancel originates
 * from the webview). Variants align with the literal unions in
 * `design.md → KIRO Extension: Module Boundaries → webview/panelProvider.ts`,
 * with field-level refinements per task 18.1:
 *  - `attachments` carries {@link AttachmentChip}, the pre-submission UI
 *    shape (filename, MIME, decoded byte count). Full attachment payloads
 *    are assembled by `panelProvider.ts` before forwarding to the relay.
 *  - String identifiers reuse the `RequestId` / `SessionId` / `AgentId`
 *    aliases from `@kiro-gpt-bridge/shared` for cross-package consistency.
 *
 * The module is deliberately VS Code-free at the type level — it depends
 * only on the structural {@link HostPostable} interface — so it can be
 * exercised under JSDOM with a stub `postMessage` implementation.
 *
 * Why no Zod here: this boundary is in-process (the extension host and the
 * webview share the same VS Code IPC pipe). Zod's overhead is not
 * justified — hand-rolled type guards are sufficient. The wire boundary
 * (extension ↔ relay) does use Zod via `shared/src/validate.ts`.
 */

import type {
  RequestId,
  SessionId,
  Session,
  AgentId,
  AgentStatus,
  TerminalStatus,
  ErrorCode,
} from '@kiro-gpt-bridge/shared';

// ─── Panel header status (R22.1) ────────────────────────────────────────────

/**
 * Status the panel header can render. The flat string union matches the
 * task 18.1 contract; richer per-state metadata (e.g. queue position)
 * travels alongside via the `agents` / `queue` fields on the
 * {@link HostToWebview} `status` variant.
 */
export type PanelStatus =
  | 'disconnected'
  | 'connected'
  | 'streaming'
  | 'queued'
  | 'cancelled';

// ─── Webview-side attachment chip (R18) ─────────────────────────────────────

/**
 * A single attachment as the dropzone (task 19.7) renders it before
 * submission. The chip UI shows `filename` and `sizeBytes`; `mimeType`
 * gates the filetype allow-list. The base64 payload itself is not on this
 * shape — the host assembles the relay-bound `Attachment` from the
 * dropzone's own buffer, so the webview ↔ host channel does not have to
 * carry the full bytes twice.
 */
export interface AttachmentChip {
  /** Original filename as the user provided it. */
  filename: string;
  /** MIME type — image/* or application/pdf, text/plain, etc. */
  mimeType: string;
  /** Size in bytes (decoded). Used by the chip UI. */
  sizeBytes: number;
}

// ─── Webview → Host union ───────────────────────────────────────────────────

/**
 * Messages the webview sends to the extension host. Discriminated union
 * keyed by `kind`. Each variant maps to a handler in
 * `webview/panelProvider.ts`'s `onDidReceiveMessage` switch.
 */
export type WebviewToHost =
  | {
      kind: 'submit';
      sessionId: SessionId;
      mode: 'chat' | 'image';
      text: string;
      attachments: AttachmentChip[];
      codeContextTokens: string[];
    }
  | { kind: 'cancel'; requestId: RequestId }
  | { kind: 'newSession' }
  | { kind: 'deleteSession'; sessionId: SessionId; confirmed: boolean }
  | { kind: 'saveMarkdown'; messageId: string; defaultName: string }
  | { kind: 'saveImage'; messageId: string; defaultName: string }
  | { kind: 'copyCode'; code: string }
  | { kind: 'insertCode'; code: string };

// ─── Host → Webview union ───────────────────────────────────────────────────

/**
 * Messages the extension host sends back to the webview. Discriminated
 * union keyed by `kind`. The fan-out variants (`status`, `agent.status`,
 * `request.queued`, …) mirror the relay's request lifecycle and the
 * fleet-wide agent state described by R7 and R8.
 */
export type HostToWebview =
  | { kind: 'status'; panelStatus: PanelStatus; agents: number; queue: number }
  | { kind: 'session.created'; sessionId: SessionId }
  | { kind: 'session.loaded'; session: Session }
  | { kind: 'request.queued'; requestId: RequestId; queuePosition: number }
  | { kind: 'request.dispatched'; requestId: RequestId; agentId: AgentId }
  | {
      kind: 'stream.chunk';
      requestId: RequestId;
      text: string;
      chunkIndex: number;
      isFinal: boolean;
      mediaType?: string;
      base64?: string;
    }
  | { kind: 'stream.interrupted'; requestId: RequestId }
  | {
      kind: 'request.terminal';
      requestId: RequestId;
      terminal: TerminalStatus;
      errorCode?: ErrorCode;
      message?: string;
    }
  | {
      kind: 'agent.status';
      agentId: AgentId;
      status: AgentStatus;
      message?: string;
    }
  | { kind: 'error'; message: string };

// ─── Host post wrapper ──────────────────────────────────────────────────────

/**
 * Structural subset of `vscode.Webview` we depend on. Modelling only the
 * `postMessage` method lets this module be tested under JSDOM with a stub.
 * Implements R12.1 (host → webview direction).
 */
export interface HostPostable {
  postMessage(msg: HostToWebview): Thenable<boolean>;
}

/**
 * Type-safe wrapper over `webview.postMessage` (host → webview direction).
 * The static type of `msg` enforces that only valid {@link HostToWebview}
 * variants are sent. Implements R12.1.
 *
 * @param target  Usually a `vscode.Webview`; any object satisfying
 *                {@link HostPostable} works (JSDOM stub, etc.).
 * @param msg     The host → webview payload.
 * @returns       The underlying `postMessage` result; `true` when the
 *                webview was reachable.
 */
export function postToWebview(
  target: HostPostable,
  msg: HostToWebview,
): Thenable<boolean> {
  return target.postMessage(msg);
}

// ─── Webview → Host parser ──────────────────────────────────────────────────

/**
 * Type-safe parser for messages received via `webview.onDidReceiveMessage`.
 * Returns `null` for any value that does not match {@link WebviewToHost}.
 * Implements R20.2 (the cancel signal originates from the webview and must
 * be parsed before it is forwarded to the relay).
 *
 * Field-level checks are intentionally structural (`typeof`,
 * `Array.isArray`); deep validation of attachment payloads is performed
 * downstream by the relay's Zod schema in `shared/src/validate.ts`.
 *
 * @param msg  Raw value from `onDidReceiveMessage`. Treated as untrusted.
 * @returns    A typed {@link WebviewToHost} when valid; otherwise `null`.
 */
export function parseWebviewMessage(msg: unknown): WebviewToHost | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (typeof m.kind !== 'string') return null;
  switch (m.kind) {
    case 'submit':
      return isSubmit(m)
        ? {
            kind: 'submit',
            sessionId: m.sessionId as SessionId,
            mode: m.mode as 'chat' | 'image',
            text: m.text as string,
            attachments: m.attachments as AttachmentChip[],
            codeContextTokens: m.codeContextTokens as string[],
          }
        : null;
    case 'cancel':
      return typeof m.requestId === 'string'
        ? { kind: 'cancel', requestId: m.requestId }
        : null;
    case 'newSession':
      return { kind: 'newSession' };
    case 'deleteSession':
      return isDeleteSession(m)
        ? {
            kind: 'deleteSession',
            sessionId: m.sessionId as SessionId,
            confirmed: m.confirmed as boolean,
          }
        : null;
    case 'saveMarkdown':
      return isSaveOp(m)
        ? {
            kind: 'saveMarkdown',
            messageId: m.messageId as string,
            defaultName: m.defaultName as string,
          }
        : null;
    case 'saveImage':
      return isSaveOp(m)
        ? {
            kind: 'saveImage',
            messageId: m.messageId as string,
            defaultName: m.defaultName as string,
          }
        : null;
    case 'copyCode':
      return typeof m.code === 'string'
        ? { kind: 'copyCode', code: m.code }
        : null;
    case 'insertCode':
      return typeof m.code === 'string'
        ? { kind: 'insertCode', code: m.code }
        : null;
    default:
      return null;
  }
}

// ─── Inline validators (kept private to keep parseWebviewMessage tidy) ──────

/**
 * Each `attachments` entry is an {@link AttachmentChip} with non-empty
 * `filename`, non-empty `mimeType`, and a finite, non-negative integer
 * `sizeBytes`. The size ceiling (25 MB after decode, R18.3) is enforced
 * by the relay; this guard only rejects structurally malformed shapes.
 */
function isAttachmentChipArray(value: unknown): value is AttachmentChip[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return false;
    const a = item as Record<string, unknown>;
    if (typeof a.filename !== 'string') return false;
    if (typeof a.mimeType !== 'string') return false;
    if (typeof a.sizeBytes !== 'number') return false;
    if (!Number.isFinite(a.sizeBytes) || a.sizeBytes < 0) return false;
  }
  return true;
}

/** Every entry in `value` is a string? */
function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) if (typeof item !== 'string') return false;
  return true;
}

/** Validate the `submit` variant of {@link WebviewToHost}. */
function isSubmit(m: Record<string, unknown>): boolean {
  if (typeof m.sessionId !== 'string') return false;
  if (m.mode !== 'chat' && m.mode !== 'image') return false;
  if (typeof m.text !== 'string') return false;
  if (!isAttachmentChipArray(m.attachments)) return false;
  if (!isStringArray(m.codeContextTokens)) return false;
  return true;
}

/** Validate the `deleteSession` variant of {@link WebviewToHost}. */
function isDeleteSession(m: Record<string, unknown>): boolean {
  if (typeof m.sessionId !== 'string') return false;
  if (typeof m.confirmed !== 'boolean') return false;
  return true;
}

/** Validate the `saveMarkdown` / `saveImage` variants of {@link WebviewToHost}. */
function isSaveOp(m: Record<string, unknown>): boolean {
  if (typeof m.messageId !== 'string') return false;
  if (typeof m.defaultName !== 'string') return false;
  return true;
}
