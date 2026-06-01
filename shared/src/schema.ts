/**
 * Wire-protocol schema — the single source of truth for every type that
 * flows over Socket.IO between the KIRO Extension, the Relay Server, and
 * the Browser Agent.
 *
 * Implements R26.1 (logical 25 MB message ceiling), R26.3 (closed enum
 * literal unions), R26.4 (image round-trip schema), R7.2 (request status
 * lifecycle).
 *
 * Conventions:
 *  - Closed enums are declared as `as const` tuples and the corresponding
 *    type is derived as `typeof TUPLE[number]` so adding a value updates
 *    the union and the runtime list at the same place.
 *  - `protocolVersion: 1` appears on every cross-process payload so the
 *    relay can reject stale clients deterministically.
 *  - Optionality (`?`) on a field means "absent on the wire is valid";
 *    fields that may carry `null` are typed explicitly.
 *  - This module declares no runtime behaviour beyond the literal-union
 *    tuples; all validation lives in downstream Zod schemas that import
 *    these tuples.
 */

import type { ErrorCode } from './errors.js';

// ─── primitives ────────────────────────────────────────────────────────────

/** Universally-unique request identifier. UUID v4 string, 36 chars. */
export type RequestId = string;

/** Server-issued client identifier. 16–64 chars. R4.4. */
export type ClientId = string;

/** Server-issued agent identifier. Fresh on every (re)connect. R3.5. */
export type AgentId = string;

/** Client-side conversation thread identifier. UUID v4 from the extension. R15.1. */
export type SessionId = string;

// ─── enums (closed lists derived as literal unions) ────────────────────────

/**
 * Every request kind the relay routes. Kept as a closed `as const` tuple so
 * {@link RequestType} is an exhaustive literal union.
 */
export const REQUEST_TYPES = ['chat', 'image'] as const;

/** Literal union derived from {@link REQUEST_TYPES}. */
export type RequestType = typeof REQUEST_TYPES[number];

/**
 * Terminal states a request can reach. Once a {@link StreamChunk} carries
 * `isFinal: true`, its `status` (when present) is one of these.
 */
export const TERMINAL_STATUSES = ['completed', 'cancelled', 'failed', 'queue_timeout'] as const;

/** Literal union derived from {@link TERMINAL_STATUSES}. */
export type TerminalStatus = typeof TERMINAL_STATUSES[number];

/**
 * Every non-terminal status a request progresses through. Implements the
 * lifecycle described by R7.2 plus the dispatch-retry and cancellation
 * sub-states.
 */
export const REQUEST_STATUSES = [
  'received', 'dispatched', 'queued', 'queued_after_dispatch_failure',
  'dispatch_retrying', 'redispatching', 'streaming',
  'cancelling', 'cancelled',
] as const;

/** Literal union derived from {@link REQUEST_STATUSES}. */
export type RequestStatus = typeof REQUEST_STATUSES[number];

/**
 * Every state a browser agent can broadcast to clients. Implements the
 * status fan-out described by R3 and R8.
 */
export const AGENT_STATUSES = ['ready', 'busy', 'login_required', 'restarting', 'disconnected'] as const;

/** Literal union derived from {@link AGENT_STATUSES}. */
export type AgentStatus = typeof AGENT_STATUSES[number];

/**
 * Visual-asset categories used by the MCP server (R29–R31). Listed here so
 * every component shares the same closed taxonomy.
 */
export const ASSET_CATEGORIES = ['logo', 'hero', 'icon', 'illustration', 'background', 'mockup', 'other'] as const;

/** Literal union derived from {@link ASSET_CATEGORIES}. */
export type AssetCategory = typeof ASSET_CATEGORIES[number];

/**
 * Closed taxonomy of the call site that submitted a Request to the relay.
 *
 * Implements R30.8 / R31.6 / R32.3 (observability for visual-asset traffic).
 * The relay-server logger emits this value verbatim under the `origin` field
 * of every Request lifecycle log entry so operators can distinguish
 * panel-driven chats, programmatic API calls, missing-asset code-lens
 * generations, and MCP-tool-driven generations from the same log stream.
 *
 * - `panel`         — the in-IDE webview panel submitted the Request.
 * - `api`           — a third-party extension called {@link KiroGptBridgeApi.generateImage}.
 * - `missing-asset` — the missing-asset code-lens command submitted the Request.
 * - `mcp`           — the `mcp-server/` package submitted the Request.
 */
export const REQUEST_ORIGINS = ['panel', 'api', 'missing-asset', 'mcp'] as const;

/** Literal union derived from {@link REQUEST_ORIGINS}. */
export type RequestOrigin = typeof REQUEST_ORIGINS[number];

// ─── Code_Context (R13, R14) ───────────────────────────────────────────────

/**
 * One `#File:` or `#Folder:` token expanded by the resolver. Implements
 * R14.1 and R14.2.
 */
export interface ExpandedToken {
  /** Original token text, e.g. "#File:src/foo.ts" or "#Folder:src". */
  token: string;
  /** Whether the token addressed a single file or a folder tree. */
  kind: 'File' | 'Folder';
  /** Byte length of the expansion this token contributed. */
  bytes: number;
}

/**
 * Editor-side context attached to a {@link Request}. Implements R13 and
 * R14. Every field is optional because the extension only fills what is
 * actually present in the active editor.
 */
export interface CodeContext {
  /** User-selected text in the active editor. 1–100000 chars. R13.2. */
  selection?: string;
  /** Absolute path of the active editor file. R13.2. */
  filePath?: string;
  /** Editor language id, e.g. "typescript". R13.2. */
  language?: string;
  /** Whole active file content when no selection is present. ≤ 200000 chars. R13.5. */
  fileContent?: string;
  /** Tokens expanded by the resolver. R14.1, R14.2. */
  expandedTokens?: ExpandedToken[];
  /** Set when the resolver truncated the context to 200 KB. R14.4. */
  truncated?: { originalSizeBytes: number; truncatedToBytes: number };
}

// ─── Attachments (R18) ─────────────────────────────────────────────────────

/**
 * A single user-supplied attachment riding alongside the prompt. The
 * 25 MB-after-decode ceiling is enforced by the relay (R18.3) and is
 * shared with all other base64 carriers in the schema.
 */
export interface Attachment {
  /** Original filename as the user provided it. */
  filename: string;
  /** MIME type — image/* or application/pdf, text/plain, etc. */
  mimeType: string;
  /** Standard-alphabet base64. ≤ 25 MB after decode (R18.3). */
  base64: string;
}

// ─── History (R15) ─────────────────────────────────────────────────────────

/**
 * A single message of the conversation window included with a
 * {@link Request} so the agent has prior context. Implements R15.
 */
export interface HistoryMessage {
  /** Speaker of this message. */
  role: 'user' | 'assistant';
  /** Plain-text body; agent-rendered media is referenced separately. */
  text: string;
  /** Epoch ms. */
  createdAt: number;
}

// ─── Request ───────────────────────────────────────────────────────────────

/**
 * A user-initiated message routed from a KIRO_Client through the relay to
 * an agent. Carries everything the agent needs to act, including optional
 * code context, conversation history, and attachments.
 */
export interface Request {
  /** Wire-protocol version literal — bumps invalidate older clients. */
  protocolVersion: 1;
  /** UUID v4 chosen by the client; idempotency key for the relay. */
  requestId: RequestId;
  /** Server-issued client identifier of the submitter. */
  clientId: ClientId;
  /** Conversation thread the request belongs to. */
  sessionId: SessionId;
  /** Whether the agent should run a chat or an image generation. */
  type: RequestType;
  /** Chat: 1–32000 chars. Image: 1–4000 chars. R9.1, R10.1. */
  prompt: string;
  /** Optional editor-side context attached by the extension. */
  codeContext?: CodeContext;
  /** 0–200 entries. Window of last N messages of the session. R15.4. */
  history?: HistoryMessage[];
  /** Each ≤ 25 MB after decode. */
  attachments?: Attachment[];
  /** Epoch ms when the extension submitted the request. */
  submittedAt: number;
  /**
   * Optional call-site tag for observability (R30.8, R31.6, R32.3). When
   * supplied, the Relay_Server emits this value under the `origin` field
   * of every lifecycle log entry for this Request. Optional so old
   * clients (and any future Request submitters that have no opinion on
   * origin) keep working untouched.
   */
  origin?: RequestOrigin;
}

// ─── Stream chunk / final response ─────────────────────────────────────────

/**
 * Incremental or final payload from the agent back to the client, fanned
 * out by the relay. A single request emits N chunks where the last one
 * has `isFinal: true`. Image responses emit a single final chunk carrying
 * `mediaType` + `base64` per R10.4.
 */
export interface StreamChunk {
  /** Wire-protocol version literal. */
  protocolVersion: 1;
  /** Identifies the originating {@link Request}. */
  requestId: RequestId;
  /** 0-based, monotonically increasing per request. */
  chunkIndex: number;
  /** Chat: incremental or final text. Image: empty string. */
  text: string;
  /** True on the last chunk of the request. */
  isFinal: boolean;
  /** Set on final image responses. R10.4. */
  mediaType?: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** Set on final image responses. ≤ 25 MB after decode. R10.4. */
  base64?: string;
  /** Set when isFinal:true and the request did not complete normally. */
  status?: TerminalStatus;
  /** Closed-enum error code; see {@link ErrorCode}. */
  errorCode?: ErrorCode;
  /** Human-readable supplement to {@link errorCode}; never user-facing copy. */
  message?: string;
}

// ─── Cancel signal ─────────────────────────────────────────────────────────

/**
 * Client → relay (and relay → agent) signal asking the in-flight request
 * to stop. Implements R20.
 */
export interface CancelSignal {
  /** Wire-protocol version literal. */
  protocolVersion: 1;
  /** Identifies the {@link Request} to cancel. */
  requestId: RequestId;
}

// ─── Status events ─────────────────────────────────────────────────────────

/**
 * Per-request lifecycle event broadcast by the relay so clients can render
 * progress indicators. Implements R7.2.
 */
export interface RequestStatusEvent {
  /** Wire-protocol version literal. */
  protocolVersion: 1;
  /** Discriminator for status-event unions. */
  kind: 'request_status';
  /** Identifies the {@link Request} this status applies to. */
  requestId: RequestId;
  /** Current lifecycle position. */
  status: RequestStatus;
  /** Agent currently handling the request, when assigned. */
  agentId?: AgentId;
  /** 1-based queue position when status === "queued". */
  queuePosition?: number;
  /** Number of dispatch retries when status === "dispatch_retrying". R5.6. */
  retryCount?: number;
}

/**
 * Agent state broadcast to all clients so UI can show "ready" / "busy" /
 * "login_required" indicators. Implements R3 and R8.
 */
export interface AgentStatusEvent {
  /** Wire-protocol version literal. */
  protocolVersion: 1;
  /** Discriminator for status-event unions. */
  kind: 'agent_status';
  /** Server-issued identifier of the agent. */
  agentId: AgentId;
  /** Current agent state. */
  status: AgentStatus;
  /** Optional human-readable supplement. */
  message?: string;
}

/**
 * Aggregate fleet snapshot broadcast to all clients on every state change.
 * Implements R8.
 */
export interface ServerStatusEvent {
  /** Wire-protocol version literal. */
  protocolVersion: 1;
  /** Discriminator for status-event unions. */
  kind: 'server_status';
  /** Total agents currently registered with the relay. */
  registeredAgents: number;
  /** Agents in any non-login_required, non-disconnected state. */
  agentsReady: number;
  /** Number of requests waiting in the queue. */
  queueDepth: number;
  /** True when every registered agent is in `login_required`. */
  loginRequiredAll: boolean;
}

// ─── Heartbeats ────────────────────────────────────────────────────────────

/**
 * Liveness ping from the browser agent to the relay. Absence triggers the
 * heartbeat-miss eviction described in R3.
 */
export interface AgentHeartbeat {
  /** Wire-protocol version literal. */
  protocolVersion: 1;
  /** Server-issued identifier of the emitting agent. */
  agentId: AgentId;
  /** Epoch ms when the heartbeat was emitted. */
  emittedAt: number;
}

// ─── Auth handshakes ───────────────────────────────────────────────────────

/**
 * First payload sent by the KIRO Extension on a fresh socket. Implements
 * R2 (shared-secret auth) and R26 (version-pinning).
 */
export interface ClientHandshake {
  /** Shared secret that the relay validates against `KIRO_SECRET`. */
  kiroSecret: string;
  /** Extension semver, used for the `protocolVersion` compatibility gate. */
  clientVersion: string;
}

/**
 * First payload sent by the Browser Agent on a fresh socket. Implements
 * R2 and the per-agent capability advertisement.
 */
export interface AgentHandshake {
  /** Shared secret that the relay validates against `AGENT_SECRET`. */
  agentSecret: string;
  /** Browser-agent semver. */
  agentVersion: string;
  /** Capabilities the agent supports; both must be true today. */
  capabilities: { chat: true; image: true };
}

// ─── Session (R15) ─────────────────────────────────────────────────────────

/**
 * Persisted record of a single message inside a {@link Session}. Used by
 * the extension's local conversation store; never crosses the wire as a
 * standalone payload.
 */
export interface SessionMessage {
  /** Stable id (UUID v4) of the message. */
  id: string;
  /** Speaker of this message. */
  role: 'user' | 'assistant';
  /** Plain-text body, when present. */
  text?: string;
  /** MIME type for image messages, e.g. "image/png". */
  mediaType?: string;
  /** Epoch ms. */
  createdAt: number;
}

/**
 * Persisted record of a conversation thread held by the extension.
 * Implements R15.
 */
export interface Session {
  /** Conversation thread identifier (UUID v4). */
  sessionId: SessionId;
  /** Epoch ms when the session was created. */
  createdAt: number;
  /** Epoch ms when the session was last updated. */
  updatedAt: number;
  /** Ordered messages of the conversation. */
  messages: SessionMessage[];
}
