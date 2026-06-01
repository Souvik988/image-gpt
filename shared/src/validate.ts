/**
 * Zod-based runtime validators for every wire-protocol payload declared in
 * {@link ./schema}. Each `validate*` function returns a discriminated result
 * of the form `{ ok: true; value } | { ok: false; firstFailingField; rule }`
 * and never throws — callers (notably the relay's ingress edge) can
 * therefore use a single uniform branch to emit `SCHEMA_INVALID` errors
 * with a precise field path.
 *
 * Implements:
 *  - R26.5 — schema validation rejects malformed wire payloads with a
 *    machine-readable first-failing-field path.
 *  - R26.6 — closed enums and bounded sizes (logical 25 MB ceiling) are
 *    enforced before any business logic runs.
 *  - R9.1  — chat prompt length is bounded to `[1, 32000]` chars.
 *  - R10.1 — image prompt length is bounded to `[1, 4000]` chars.
 *  - R10.7 — empty or oversize image prompts are rejected up front.
 *  - R15.4 — request history is bounded to `[0, 200]` entries.
 *
 * Design notes:
 *  - `protocolVersion` is locked to the literal `1` on every cross-process
 *    payload so older clients cannot leak through after a bump.
 *  - Per-field bounds in this module are the wire-shape minimum; tighter
 *    layer-specific rules (e.g. `clientId` 16–64 chars per R4.4) live in
 *    the relay's own ingress schema where that policy is enforced.
 *  - Base64 carriers are bounded by encoded length: 35,000,000 chars is
 *    the smallest encoded length that, in standard alphabet with padding,
 *    can decode to a value above the 25 MiB ceiling. Using the encoded
 *    length avoids a decode pass on every message and is conservative —
 *    well-formed input ≤ 35 M chars cannot exceed 25 MiB after decode.
 *  - `RequestSchema` is built as a `z.discriminatedUnion('type', …)` so
 *    chat (1–32000) and image (1–4000) prompts get distinct length bounds
 *    while sharing every other field (R9.1, R10.1).
 */

import { z, type ZodError } from 'zod';
import {
  REQUEST_TYPES,
  TERMINAL_STATUSES,
  REQUEST_STATUSES,
  AGENT_STATUSES,
  ASSET_CATEGORIES,
  REQUEST_ORIGINS,
  type RequestType,
  type TerminalStatus,
  type RequestStatus,
  type AgentStatus,
  type AssetCategory,
  type RequestOrigin,
  type Request,
  type StreamChunk,
  type CancelSignal,
  type RequestStatusEvent,
  type AgentStatusEvent,
  type ServerStatusEvent,
  type AgentHeartbeat,
  type ClientHandshake,
  type AgentHandshake,
  type CodeContext,
  type Attachment,
  type HistoryMessage,
  type Session,
  type SessionMessage,
} from './schema.js';
import { ERROR_CODES, type ErrorCode } from './errors.js';

// ─── Shared bounds ─────────────────────────────────────────────────────────

/** Maximum chat prompt length in chars (R9.1). */
const CHAT_PROMPT_MAX = 32_000;

/** Maximum image prompt length in chars (R10.1, R10.7). */
const IMAGE_PROMPT_MAX = 4_000;

/** Maximum history window size (R15.4). */
const HISTORY_MAX = 200;

/** Maximum char length of `codeContext.selection` (R13.2). */
const SELECTION_MAX = 100_000;

/** Maximum char length of `codeContext.fileContent` (R13.5). */
const FILE_CONTENT_MAX = 200_000;

/** Maximum filename length on attachments (filesystem-portable upper bound). */
const FILENAME_MAX = 255;

/**
 * Smallest encoded base64 length whose decode could exceed 25 MiB. Used as
 * an upper bound on every base64 carrier (Attachment.base64,
 * StreamChunk.base64). See "Design notes" at the top of this file.
 */
const BASE64_ENCODED_MAX = 35_000_000;

// ─── Public result type ────────────────────────────────────────────────────

/** Successful validation: `value` is the parsed wire object, fully typed. */
export type ValidateOk<T> = { ok: true; value: T };

/**
 * Failed validation. `firstFailingField` is the dotted path of the first
 * Zod issue (e.g. `"codeContext.attachments.0.base64"` or `"prompt"`),
 * `rule` is `${issue.code}: ${issue.message}` truncated to keep log lines
 * compact.
 */
export type ValidateErr = { ok: false; firstFailingField: string; rule: string };

/**
 * Discriminated result returned by every `validate*` function.
 * Callers branch on `ok` and either flow the value into business logic
 * or emit a `SCHEMA_INVALID` error with the first failing field.
 */
export type ValidateResult<T> = ValidateOk<T> | ValidateErr;

// ─── Closed-enum schemas ───────────────────────────────────────────────────
//
// `z.enum` requires a non-empty `readonly [string, ...string[]]` tuple at
// the type level. The `as unknown as readonly [string, ...string[]]` cast
// below is a typing-only conversion: the runtime tuples are already
// non-empty `as const` literals from `schema.ts` / `errors.ts`. The cast
// is documented inline because it is the only place this module narrows
// the closed-tuple typing, and it cannot be avoided without sacrificing
// the single-source-of-truth tuples.

/** Closed-enum schema for {@link RequestType} (`chat` | `image`). */
export const RequestTypeSchema: z.ZodEnum<[RequestType, ...RequestType[]]> =
  z.enum(REQUEST_TYPES as unknown as readonly [RequestType, ...RequestType[]]);

/** Closed-enum schema for {@link TerminalStatus}. */
export const TerminalStatusSchema: z.ZodEnum<[TerminalStatus, ...TerminalStatus[]]> =
  z.enum(TERMINAL_STATUSES as unknown as readonly [TerminalStatus, ...TerminalStatus[]]);

/** Closed-enum schema for {@link RequestStatus}. */
export const RequestStatusSchema: z.ZodEnum<[RequestStatus, ...RequestStatus[]]> =
  z.enum(REQUEST_STATUSES as unknown as readonly [RequestStatus, ...RequestStatus[]]);

/** Closed-enum schema for {@link AgentStatus}. */
export const AgentStatusSchema: z.ZodEnum<[AgentStatus, ...AgentStatus[]]> =
  z.enum(AGENT_STATUSES as unknown as readonly [AgentStatus, ...AgentStatus[]]);

/** Closed-enum schema for {@link AssetCategory} (R29–R31). */
export const AssetCategorySchema: z.ZodEnum<[AssetCategory, ...AssetCategory[]]> =
  z.enum(ASSET_CATEGORIES as unknown as readonly [AssetCategory, ...AssetCategory[]]);

/**
 * Closed-enum schema for {@link RequestOrigin} (R30.8 / R31.6 / R32.3).
 *
 * Used to validate the optional `origin` field on inbound Requests at
 * the relay's ingress edge (`clientHandlers.ts`). When the field is
 * absent the relay logs without an `origin` tag, so older clients keep
 * working untouched.
 */
export const RequestOriginSchema: z.ZodEnum<[RequestOrigin, ...RequestOrigin[]]> =
  z.enum(REQUEST_ORIGINS as unknown as readonly [RequestOrigin, ...RequestOrigin[]]);

/** Closed-enum schema for {@link ErrorCode}. */
export const ErrorCodeSchema: z.ZodEnum<[ErrorCode, ...ErrorCode[]]> =
  z.enum(ERROR_CODES as unknown as readonly [ErrorCode, ...ErrorCode[]]);

/** Closed list of media types allowed on a final image chunk (R10.4). */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** Closed-enum schema for the four image MIME types accepted on the wire. */
export const ImageMediaTypeSchema = z.enum(IMAGE_MEDIA_TYPES);

/** `protocolVersion` is the literal `1` for every cross-process payload. */
const protocolVersionSchema = z.literal(1);

// ─── Building-block schemas ────────────────────────────────────────────────

/**
 * One `#File:` or `#Folder:` token expanded by the resolver. Mirrors
 * {@link import('./schema.js').ExpandedToken}.
 */
export const ExpandedTokenSchema = z.object({
  token: z.string().min(1),
  kind: z.enum(['File', 'Folder']),
  bytes: z.number().int().nonnegative(),
});

/**
 * Editor-side context block attached to a {@link Request}. Implements R13
 * and R14 length bounds. Every field is optional because the extension
 * only fills what is present in the active editor.
 */
export const CodeContextSchema = z.object({
  selection: z.string().max(SELECTION_MAX).optional(),
  filePath: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  fileContent: z.string().max(FILE_CONTENT_MAX).optional(),
  expandedTokens: z.array(ExpandedTokenSchema).optional(),
  truncated: z
    .object({
      originalSizeBytes: z.number().int().nonnegative(),
      truncatedToBytes: z.number().int().nonnegative(),
    })
    .optional(),
});

/**
 * A single user-supplied attachment. The `base64` length cap of
 * 35,000,000 chars is a conservative upper bound on the 25 MiB
 * decoded-byte ceiling required by R18.3 and R26.1.
 */
export const AttachmentSchema = z.object({
  filename: z.string().min(1).max(FILENAME_MAX),
  mimeType: z.string().min(1),
  base64: z.string().refine((s) => s.length <= BASE64_ENCODED_MAX, {
    message: 'base64 length implies > 25 MB after decode',
  }),
});

/**
 * One message of the conversation window included with a {@link Request}.
 */
export const HistoryMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  createdAt: z.number().int().nonnegative(),
});

// ─── Request (discriminated union on `type`) ───────────────────────────────

/**
 * Fields shared between the `chat` and `image` arms of {@link RequestSchema}.
 * Extracted as a record literal so both arms stay byte-identical except
 * for the `type` discriminator and the prompt length bound.
 */
const requestSharedFields = {
  protocolVersion: protocolVersionSchema,
  requestId: z.string().min(1),
  clientId: z.string().min(1),
  sessionId: z.string().min(1),
  codeContext: CodeContextSchema.optional(),
  history: z.array(HistoryMessageSchema).max(HISTORY_MAX).optional(),
  attachments: z.array(AttachmentSchema).optional(),
  submittedAt: z.number().int().nonnegative(),
  /**
   * Optional submitter call-site tag (R30.8 / R31.6 / R32.3). Older
   * clients that do not set this field continue to validate; the
   * relay's logger simply omits the `origin` field for those entries.
   */
  origin: RequestOriginSchema.optional(),
} as const;

/** `chat`-typed request: prompt 1–32000 chars (R9.1). */
const chatRequestSchema = z.object({
  ...requestSharedFields,
  type: z.literal('chat'),
  prompt: z.string().min(1).max(CHAT_PROMPT_MAX),
});

/** `image`-typed request: prompt 1–4000 chars (R10.1, R10.7). */
const imageRequestSchema = z.object({
  ...requestSharedFields,
  type: z.literal('image'),
  prompt: z.string().min(1).max(IMAGE_PROMPT_MAX),
});

/**
 * Wire schema for {@link Request}. Implements R9.1, R10.1, R10.7, R15.4
 * via a discriminated union on `type` so chat and image prompts get the
 * correct distinct length bounds in a single parse pass.
 */
export const RequestSchema = z.discriminatedUnion('type', [
  chatRequestSchema,
  imageRequestSchema,
]);

// ─── StreamChunk ───────────────────────────────────────────────────────────

/**
 * Wire schema for {@link StreamChunk}. The `base64` cap of
 * {@link BASE64_ENCODED_MAX} chars is a conservative pre-decode bound on
 * the 25 MiB ceiling. Caller-side decode validates the exact byte length
 * for streams that need it.
 */
export const StreamChunkSchema = z.object({
  protocolVersion: protocolVersionSchema,
  requestId: z.string().min(1),
  chunkIndex: z.number().int().nonnegative(),
  text: z.string(),
  isFinal: z.boolean(),
  mediaType: ImageMediaTypeSchema.optional(),
  base64: z.string().max(BASE64_ENCODED_MAX).optional(),
  status: TerminalStatusSchema.optional(),
  errorCode: ErrorCodeSchema.optional(),
  message: z.string().optional(),
});

// ─── CancelSignal ──────────────────────────────────────────────────────────

/** Wire schema for {@link CancelSignal}. */
export const CancelSignalSchema = z.object({
  protocolVersion: protocolVersionSchema,
  requestId: z.string().min(1),
});

// ─── Status events ─────────────────────────────────────────────────────────

/** Wire schema for {@link RequestStatusEvent} (R7.2). */
export const RequestStatusEventSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('request_status'),
  requestId: z.string().min(1),
  status: RequestStatusSchema,
  agentId: z.string().min(1).optional(),
  queuePosition: z.number().int().positive().optional(),
  retryCount: z.number().int().nonnegative().optional(),
});

/** Wire schema for {@link AgentStatusEvent} (R3, R8). */
export const AgentStatusEventSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('agent_status'),
  agentId: z.string().min(1),
  status: AgentStatusSchema,
  message: z.string().optional(),
});

/** Wire schema for {@link ServerStatusEvent} (R8). */
export const ServerStatusEventSchema = z.object({
  protocolVersion: protocolVersionSchema,
  kind: z.literal('server_status'),
  registeredAgents: z.number().int().nonnegative(),
  agentsReady: z.number().int().nonnegative(),
  queueDepth: z.number().int().nonnegative(),
  loginRequiredAll: z.boolean(),
});

// ─── Heartbeat ─────────────────────────────────────────────────────────────

/** Wire schema for {@link AgentHeartbeat}. */
export const AgentHeartbeatSchema = z.object({
  protocolVersion: protocolVersionSchema,
  agentId: z.string().min(1),
  emittedAt: z.number().int().nonnegative(),
});

// ─── Auth handshakes ───────────────────────────────────────────────────────

/**
 * Wire schema for {@link ClientHandshake}. Length policy on `kiroSecret`
 * (16–256 chars per R2.5) lives in the relay's auth layer; this schema
 * just enforces a non-empty string at the wire boundary.
 */
export const ClientHandshakeSchema = z.object({
  kiroSecret: z.string().min(1),
  clientVersion: z.string().min(1),
});

/**
 * Wire schema for {@link AgentHandshake}. Both capabilities must be
 * literally `true` today (closed list per design).
 */
export const AgentHandshakeSchema = z.object({
  agentSecret: z.string().min(1),
  agentVersion: z.string().min(1),
  capabilities: z.object({
    chat: z.literal(true),
    image: z.literal(true),
  }),
});

// ─── Session (R15) ─────────────────────────────────────────────────────────

/**
 * Persisted record of a single message inside a {@link Session}. Used by
 * the extension's local conversation store; never crosses the wire as a
 * standalone payload.
 */
export const SessionMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  text: z.string().optional(),
  mediaType: z.string().min(1).optional(),
  createdAt: z.number().int().nonnegative(),
});

/**
 * Persisted record of a conversation thread held by the extension.
 * Implements R15 storage shape.
 */
export const SessionSchema = z.object({
  sessionId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  messages: z.array(SessionMessageSchema),
});

// ─── Failure projection ────────────────────────────────────────────────────

/** Hard cap on the `rule` string so log lines stay column-aligned. */
const RULE_MAX = 200;

/**
 * Project a {@link ZodError} to the failure arm of {@link ValidateResult}.
 * Selects the first issue, renders `issue.path` as a dotted string (e.g.
 * `codeContext.attachments.0.base64`) and `rule` as
 * `${issue.code}: ${issue.message}` truncated to {@link RULE_MAX} chars.
 *
 * For a discriminated-union mismatch on `type`, Zod sets `issue.path` to
 * `['type']`, so the dotted path is `"type"`. For a top-level missing
 * field like `protocolVersion`, the path is `['protocolVersion']`. If
 * Zod ever emits an issue with an empty path (defensive fallback), the
 * sentinel `<root>` is used so downstream log emitters never have to
 * guard against empty strings.
 */
function failureFromError(err: ZodError): ValidateErr {
  const issue = err.issues[0];
  if (!issue) {
    return { ok: false, firstFailingField: '<root>', rule: 'unknown' };
  }
  const firstFailingField = issue.path.length === 0 ? '<root>' : issue.path.join('.');
  const rule = `${issue.code}: ${issue.message}`.slice(0, RULE_MAX);
  return { ok: false, firstFailingField, rule };
}

/**
 * Run a Zod schema against `input` and project the result to
 * {@link ValidateResult}. Uses `safeParse` so this helper never throws.
 */
function runSchema<T>(schema: z.ZodType<T>, input: unknown): ValidateResult<T> {
  const result = schema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return failureFromError(result.error);
}

// ─── Public validators ─────────────────────────────────────────────────────

/**
 * Validate an unknown value against the {@link Request} wire schema.
 * Implements R26.5, R26.6, R9.1, R10.1, R10.7, R15.4.
 */
export function validateRequest(input: unknown): ValidateResult<Request> {
  return runSchema(RequestSchema as unknown as z.ZodType<Request>, input);
}

/**
 * Validate an unknown value against the {@link StreamChunk} wire schema.
 * Implements R26.5, R26.6.
 */
export function validateStreamChunk(input: unknown): ValidateResult<StreamChunk> {
  return runSchema(StreamChunkSchema as unknown as z.ZodType<StreamChunk>, input);
}

/**
 * Validate an unknown value against the {@link CancelSignal} wire schema.
 * Implements R26.5, R26.6.
 */
export function validateCancelSignal(input: unknown): ValidateResult<CancelSignal> {
  return runSchema(CancelSignalSchema as unknown as z.ZodType<CancelSignal>, input);
}

/**
 * Validate an unknown value against the {@link AgentHeartbeat} wire schema.
 * Implements R26.5, R26.6.
 */
export function validateAgentHeartbeat(input: unknown): ValidateResult<AgentHeartbeat> {
  return runSchema(AgentHeartbeatSchema as unknown as z.ZodType<AgentHeartbeat>, input);
}

/**
 * Validate an unknown value against the {@link ClientHandshake} wire schema.
 * Implements R26.5, R26.6.
 */
export function validateClientHandshake(input: unknown): ValidateResult<ClientHandshake> {
  return runSchema(ClientHandshakeSchema as unknown as z.ZodType<ClientHandshake>, input);
}

/**
 * Validate an unknown value against the {@link AgentHandshake} wire schema.
 * Implements R26.5, R26.6.
 */
export function validateAgentHandshake(input: unknown): ValidateResult<AgentHandshake> {
  return runSchema(AgentHandshakeSchema as unknown as z.ZodType<AgentHandshake>, input);
}

/**
 * Validate an unknown value against the {@link RequestStatusEvent} wire
 * schema. Implements R26.5 (used by clients before rendering UI).
 */
export function validateRequestStatusEvent(input: unknown): ValidateResult<RequestStatusEvent> {
  return runSchema(RequestStatusEventSchema as unknown as z.ZodType<RequestStatusEvent>, input);
}

/**
 * Validate an unknown value against the {@link AgentStatusEvent} wire
 * schema. Implements R26.5.
 */
export function validateAgentStatusEvent(input: unknown): ValidateResult<AgentStatusEvent> {
  return runSchema(AgentStatusEventSchema as unknown as z.ZodType<AgentStatusEvent>, input);
}

/**
 * Validate an unknown value against the {@link ServerStatusEvent} wire
 * schema. Implements R26.5.
 */
export function validateServerStatusEvent(input: unknown): ValidateResult<ServerStatusEvent> {
  return runSchema(ServerStatusEventSchema as unknown as z.ZodType<ServerStatusEvent>, input);
}

/**
 * Validate an unknown value against the persisted {@link Session} record
 * shape. Used by the extension's session store on disk-load.
 */
export function validateSession(input: unknown): ValidateResult<Session> {
  return runSchema(SessionSchema as unknown as z.ZodType<Session>, input);
}

/**
 * Validate an unknown value against the persisted {@link SessionMessage}
 * record shape. Used by the extension's session store.
 */
export function validateSessionMessage(input: unknown): ValidateResult<SessionMessage> {
  return runSchema(SessionMessageSchema as unknown as z.ZodType<SessionMessage>, input);
}

/**
 * Validate an unknown value against the {@link CodeContext} schema.
 * Used by the extension when round-tripping editor context blocks.
 */
export function validateCodeContext(input: unknown): ValidateResult<CodeContext> {
  return runSchema(CodeContextSchema as unknown as z.ZodType<CodeContext>, input);
}

/**
 * Validate an unknown value against the {@link Attachment} schema.
 * Implements R18.3 (25 MiB ceiling enforced via `base64` length cap).
 */
export function validateAttachment(input: unknown): ValidateResult<Attachment> {
  return runSchema(AttachmentSchema as unknown as z.ZodType<Attachment>, input);
}

/**
 * Validate an unknown value against the {@link HistoryMessage} schema.
 */
export function validateHistoryMessage(input: unknown): ValidateResult<HistoryMessage> {
  return runSchema(HistoryMessageSchema as unknown as z.ZodType<HistoryMessage>, input);
}
