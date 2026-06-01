/**
 * Closed list of all error codes that can appear on the wire.
 *
 * Implements R26.5, R26.6 and every requirement that defines an error code.
 *
 * The list is intentionally a `readonly` tuple so that:
 *  - `ErrorCode` can be derived as a literal union (compile-time exhaustiveness),
 *  - the wire contract is locked by a snapshot test (see task 2.8),
 *  - downstream consumers (validators, log emitters, MCP server) all share a
 *    single source of truth.
 *
 * Each entry has an inline comment naming the requirement(s) that introduce it.
 *
 * The first 18 entries are the "core" relay/agent error codes from the
 * "Error Code Taxonomy" section of design.md. The final 3 entries
 * (`WORKSPACE_REQUIRED`, `TARGET_EXISTS`, `RELAY_UNREACHABLE`) were added by
 * the visual-asset automation requirements R29–R31 and live in the same
 * tuple so the taxonomy stays single-source-of-truth.
 */
export const ERROR_CODES = [
  // ─── Core relay / agent codes (design.md §"Error Code Taxonomy") ───
  'PAYLOAD_TOO_LARGE',        // R1.4  — Socket.IO frame > 100 MB
  'SCHEMA_INVALID',           // R26.5 — Schema validation failed
  'MALFORMED_INPUT',          // R26.6 — Not well-formed UTF-8 JSON
  'MESSAGE_TOO_LARGE',        // R26.6 — Logical message > 25 MB
  'QUEUE_FULL',               // R6.6  — Queue at QUEUE_MAX_DEPTH
  'QUEUE_TIMEOUT',            // R6.7, R7.7 — In-queue > 600 s
  'AGENT_DISCONNECTED',       // R3.4, R7.8 — Agent vanished after 3 redispatches
  'CHATGPT_ERROR',            // R9.6  — Visible chat error in DOM
  'CHATGPT_UNAVAILABLE',      // R10.8 — Page unreachable / not loaded
  'INPUT_UNAVAILABLE',        // R9.7  — Cannot focus chat input in 5 s
  'CHAT_TIMEOUT',             // R9.8  — No chat chunks in 120 s
  'IMAGE_TIMEOUT',            // R10.5 — No image in 180 s
  'CONTENT_POLICY',           // R10.6 — DALL-E refusal
  'INVALID_PROMPT',           // R10.7 — Image prompt empty / > 4000 chars
  'CANCEL_DELIVERY_FAILED',   // R20.7 — Cancel undeliverable in 5 s
  'SHUTDOWN',                 // R1.6  — In-flight aborted by SIGTERM/SIGINT
  'AUTH_FAILED',              // R2.3, R2.6 — Bad/missing secret or rate-limited
  'CAPACITY_EXCEEDED',        // R4.7  — > 50 concurrent clients
  // ─── Visual-asset automation codes (R29–R31) ───
  'WORKSPACE_REQUIRED',       // R29.5 — MCP tool invoked without an open workspace
  'TARGET_EXISTS',            // R29.6, R30.4 — Asset target path already occupied
  'RELAY_UNREACHABLE',        // R31.7 — MCP server cannot reach the relay
] as const;

/**
 * Literal union of every wire-level error code.
 *
 * Derived from {@link ERROR_CODES} so adding a new code in one place updates
 * the type everywhere.
 */
export type ErrorCode = typeof ERROR_CODES[number];

/**
 * Type guard for {@link ErrorCode}. Useful for narrowing values that arrive
 * from the wire (e.g. inside a `stream.chunk` payload that has already passed
 * schema validation, or in MCP tool responses where the error code field is
 * typed as `string`).
 *
 * Implements the "closed enum" requirement of R26.5/R26.6: any value not in
 * {@link ERROR_CODES} is rejected.
 */
export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === 'string' &&
    (ERROR_CODES as readonly string[]).includes(value)
  );
}
