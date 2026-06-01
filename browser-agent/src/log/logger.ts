/**
 * Browser Agent structured-JSON logger.
 *
 * Implements R24.6: when any of the following events occurs in the
 * Browser_Agent — Request received, Stream_Chunk emitted, or error
 * encountered — the Browser_Agent emits a structured JSON log entry
 * containing `timestamp`, `requestId`, `eventType`, and (for stream
 * chunks) `chunkIndex`, and (for errors) `errorCategory`.
 *
 * Why we don't use `pino` here: the browser-agent runs on user laptops
 * alongside puppeteer + Chromium and we want to keep its dependency
 * footprint minimal. For an output contract this narrow — one NDJSON
 * line per event written to stdout — a tiny purpose-built logger is
 * preferable to another transitive dependency tree.
 *
 * Output contract (NDJSON):
 *   - Each `logAgentEvent` call produces exactly one
 *     `JSON.stringify(entry) + "\n"` write to `process.stdout`.
 *   - `timestamp` is auto-stamped with `new Date().toISOString()` —
 *     ISO 8601 UTC with millisecond precision — when not supplied.
 *   - `eventType === 'agent.stream_chunk_emitted'` requires a numeric
 *     `chunkIndex`; otherwise the entry is dropped and the failure
 *     counter is bumped.
 *   - `eventType === 'agent.error'` requires a non-empty string
 *     `errorCategory`; otherwise the entry is dropped and the failure
 *     counter is bumped.
 *   - All work is wrapped in try/catch; a closed stdout (broken pipe,
 *     redirected to a dropped FD) bumps the failure counter rather
 *     than throwing.
 *
 * @packageDocumentation
 */

/**
 * Closed list of Browser_Agent event types per R24.6.
 *
 * `agent.stream_chunk_emitted` requires `chunkIndex`; `agent.error`
 * requires `errorCategory`. All other event types may carry the
 * optional `requestId` and free-form supplementary fields.
 */
export type AgentEventType =
  | 'agent.boot'
  | 'agent.config_loaded'
  | 'agent.relay_connected'
  | 'agent.relay_disconnected'
  | 'agent.heartbeat_emitted'
  | 'agent.dispatch_received'
  | 'agent.chat_submit'
  | 'agent.image_submit'
  | 'agent.image_captured'
  | 'agent.stream_chunk_emitted'
  | 'agent.cancel_received'
  | 'agent.cancel_executed'
  | 'agent.state_transition'
  | 'agent.login_required'
  | 'agent.ready'
  | 'agent.restarting'
  | 'agent.error';

/**
 * Shape of one log entry passed to {@link logAgentEvent}.
 *
 * `timestamp` is auto-stamped when absent. `chunkIndex` is required
 * for `agent.stream_chunk_emitted` and `errorCategory` is required
 * for `agent.error` per R24.6. Any other keys are forwarded into the
 * JSON output verbatim, so callers can attach contextual fields
 * (e.g., `agentId`, `requestId`, `version`) without changing this
 * type.
 */
export interface AgentLogFields {
  /** ISO 8601 UTC ms-precision; auto-set if absent. */
  timestamp?: string;
  /** Event type per R24.6. See {@link AgentEventType}. */
  eventType: AgentEventType;
  /** RequestId correlation, when the event belongs to a request. */
  requestId?: string;
  /** Chunk ordinal — required when `eventType === 'agent.stream_chunk_emitted'`. */
  chunkIndex?: number;
  /** Error category — required when `eventType === 'agent.error'` per R24.6. */
  errorCategory?: string;
  /** Free-form supplementary fields. */
  [key: string]: unknown;
}

/**
 * Internal write-failure counter. Bumped whenever a `logAgentEvent`
 * call cannot produce an NDJSON line — either because the entry
 * violated a required-field invariant or because writing to stdout
 * threw. Exposed read-only via {@link getLogFailures} so the agent
 * supervisor / metrics layer can observe drops without reaching into
 * module state.
 */
let logFailures = 0;

/**
 * Emit one structured JSON log line to stdout. Implements R24.6.
 *
 * The call is wrapped in try/catch — any thrown error (closed stdout,
 * unexpected serialization failure) bumps {@link getLogFailures} and
 * is swallowed. Returns void synchronously and never throws.
 *
 * @param fields Log entry fields. `timestamp` is auto-stamped when absent.
 *   `agent.stream_chunk_emitted` requires a numeric `chunkIndex`;
 *   `agent.error` requires a non-empty string `errorCategory`. Entries
 *   that fail these invariants are dropped and bump the failure counter.
 */
export function logAgentEvent(fields: AgentLogFields): void {
  try {
    const out: AgentLogFields = {
      timestamp: fields.timestamp ?? new Date().toISOString(),
      ...fields,
    };
    // Stream chunks must carry chunkIndex; errors must carry errorCategory.
    if (
      fields.eventType === 'agent.stream_chunk_emitted' &&
      typeof fields.chunkIndex !== 'number'
    ) {
      logFailures += 1;
      return;
    }
    if (
      fields.eventType === 'agent.error' &&
      (typeof fields.errorCategory !== 'string' || fields.errorCategory.length === 0)
    ) {
      logFailures += 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch {
    logFailures += 1;
  }
}

/**
 * Read the running count of log-write failures since process start
 * (or the most recent {@link _resetLogFailuresForTests} call).
 *
 * Consumed by tests and by the agent supervisor's health probe so a
 * silently-broken stdout cannot hide.
 */
export function getLogFailures(): number {
  return logFailures;
}

/**
 * Test-only counter reset.
 *
 * Production code MUST NOT call this — `logFailures` is a monotonic
 * counter for the lifetime of the agent process. The leading
 * underscore marks it as a non-public escape hatch for unit tests.
 */
export function _resetLogFailuresForTests(): void {
  logFailures = 0;
}
