/**
 * Structured JSON logger for the Relay_Server.
 *
 * Implements:
 * - R24.1: Request lifecycle events (received, dispatched, queued, completed,
 *   cancelled, failed) are emitted as a single structured JSON line.
 * - R24.2: Each entry carries the required fields `timestamp` (ISO 8601 UTC
 *   with millisecond precision), `requestId`, `clientId`, `eventType` (all
 *   non-empty strings) and the optional `agentId` (string or null) and
 *   `durationMs` (non-negative integer or omitted).
 * - R24.3: `durationMs` is required for terminal events
 *   (`completed`, `cancelled`, `failed`, `queue_timeout`). Entries that violate
 *   this constraint are rejected and recorded as a log failure rather than
 *   silently emitting a malformed line.
 * - R24.4: A logging failure (validation rejection, stdout closed, disk write
 *   error, etc.) NEVER throws. The internal `logFailures` counter is bumped
 *   and the call returns. The counter is exposed via {@link getLogFailures}
 *   so the `/metrics` endpoint (task 4.4) can surface it as
 *   `log_failures_total`.
 * - R30.8 / R31.6 / R32.3: Lifecycle entries carry an optional closed-enum
 *   `origin` field (`'panel' | 'api' | 'missing-asset' | 'mcp'`) so operators
 *   can attribute visual-asset traffic back to the call site that submitted
 *   the Request. The relay reads the value from the wire `Request.origin`
 *   field set by the submitter (extension panel / extensionApi / missing-asset
 *   command / mcp-server) and threads it into every lifecycle entry for that
 *   Request via the dispatcher.
 *
 * Design notes:
 * - Built on `pino` with a custom `timestamp` serializer that emits the
 *   timestamp under the field name `timestamp` (the default pino field name
 *   `time` is overridden because R24.2 mandates `timestamp`).
 * - The level serializer is overridden so the emitted level is the textual
 *   label (e.g., `"info"`) rather than the numeric pino default (e.g., `30`).
 * - Module-level state (singleton `logger` and `logFailures` counter) is used
 *   by design: a Relay_Server process has exactly one stdout sink, and Node is
 *   single-threaded so no synchronisation is required.
 * - {@link logRequestEvent} accepts arbitrary additional fields via an index
 *   signature so callers can extend the entry shape without a breaking change
 *   to this module's public surface.
 *
 * @module relay-server/log/logger
 */

import { pino, type Logger as PinoLogger, type LoggerOptions } from 'pino';

/**
 * Base pino options shared by the singleton logger and any future child
 * loggers. Exported so tests can construct an isolated logger with the same
 * formatting rules.
 *
 * - `formatters.level` returns `{ level: <label> }` so the level is serialised
 *   as a string (`"info"`, `"warn"`, `"error"`) rather than the pino default
 *   numeric code.
 * - `timestamp` returns a JSON fragment beginning with a comma and the
 *   `"timestamp"` key (R24.2). pino prepends this fragment after the level
 *   field. `new Date().toISOString()` guarantees ISO 8601 UTC with millisecond
 *   precision.
 */
export const PINO_BASE_OPTIONS: LoggerOptions = {
  formatters: {
    level: (label: string): { level: string } => ({ level: label }),
  },
  timestamp: (): string => `,"timestamp":"${new Date().toISOString()}"`,
};

/**
 * Closed list of every Request lifecycle event the relay accepts.
 *
 * Covers the canonical R24.1 events (received, dispatched, queued, completed,
 * cancelled, failed) plus the dispatcher-internal transitions documented in
 * `design.md`: `queued_after_dispatch_failure`, `dispatch_retrying`,
 * `redispatching`, `streaming`, `cancelling`, `queue_timeout`.
 */
export type RequestEventType =
  | 'received'
  | 'dispatched'
  | 'queued'
  | 'queued_after_dispatch_failure'
  | 'dispatch_retrying'
  | 'redispatching'
  | 'streaming'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'queue_timeout';

/**
 * Subset of {@link RequestEventType} for which `durationMs` is required by
 * R24.3. `queue_timeout` is included because, like the other terminal events,
 * it ends the Request lifecycle and must report elapsed time from `received`.
 */
const TERMINAL_EVENT_TYPES: ReadonlySet<RequestEventType> = new Set<RequestEventType>([
  'completed',
  'cancelled',
  'failed',
  'queue_timeout',
]);

/**
 * Required and optional fields on a single Relay_Server Request lifecycle log
 * entry.
 *
 * The index signature `[key: string]: unknown` allows arbitrary additional
 * fields. Task 22.9 uses this hook to attach an `origin` tag without a
 * breaking change to the helper's signature.
 *
 * Implements R24.2 (required field shape), R24.3 (`durationMs` rule), and
 * R30.8 / R31.6 / R32.3 (visual-asset traffic origin tag).
 */
export interface RequestEventFields {
  /** Non-empty Request id. R24.2. */
  requestId: string;
  /** Non-empty Client id. R24.2. */
  clientId: string;
  /**
   * Agent id (non-empty string) or null when the event predates dispatch
   * (e.g., `received`, `queued`). R24.2.
   */
  agentId?: string | null;
  /** Lifecycle event type. R24.2. */
  eventType: RequestEventType;
  /**
   * Elapsed milliseconds from `received` to this event. Required when
   * `eventType` is in {@link TERMINAL_EVENT_TYPES} (R24.3). Must be a
   * non-negative integer when supplied.
   */
  durationMs?: number;
  /**
   * Closed-enum tag identifying the call site that submitted the Request
   * to the relay (R30.8 / R31.6 / R32.3). Optional so older clients
   * (and any non-visual-asset Request submitter that has no opinion on
   * origin) keep working untouched. When absent, the field is simply
   * omitted from the emitted JSON line.
   *
   * - `panel`         — extension webview panel.
   * - `api`           — third-party extension calling the public extension API.
   * - `missing-asset` — missing-asset code-lens command.
   * - `mcp`           — `mcp-server/` package.
   */
  origin?: 'panel' | 'api' | 'missing-asset' | 'mcp';
  /**
   * Free-form additional fields. Future tasks extend the entry shape
   * through this index signature.
   */
  [key: string]: unknown;
}

/**
 * Module-level singleton pino logger. Writes JSON lines to stdout.
 *
 * Internal — call sites use {@link logRequestEvent} or {@link logSafe} instead
 * of touching this directly so failures are caught.
 */
const logger: PinoLogger = pino(PINO_BASE_OPTIONS);

/**
 * Running count of log emission failures since process start. Bumped whenever
 * {@link logRequestEvent} or {@link logSafe} catches an error or rejects an
 * invalid entry. Surfaced via {@link getLogFailures} for the `/metrics`
 * endpoint (R24.4).
 */
let logFailures = 0;

/**
 * Returns true when `value` is a finite, non-negative integer suitable for
 * use as `durationMs`.
 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Returns true when `value` is a non-empty string.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Closed set of accepted {@link RequestEventFields.origin} values. Mirrors
 * the wire-side `REQUEST_ORIGINS` tuple in `@kiro-gpt-bridge/shared`. We
 * duplicate the tuple here rather than import it so this module stays
 * dependency-light (the logger sits on the hot path of every lifecycle
 * event and the relay-server runtime treats `@kiro-gpt-bridge/shared`
 * as a peer rather than transitively-loading it from the log module).
 *
 * Implements R30.8 / R31.6 / R32.3.
 */
const VALID_ORIGINS: ReadonlySet<string> = new Set<string>([
  'panel',
  'api',
  'missing-asset',
  'mcp',
]);

/**
 * Emit one structured JSON log entry for a Request lifecycle event.
 *
 * Validation per R24.2, R24.3 and R30.8:
 * - `requestId`, `clientId`, `eventType` must be non-empty strings.
 * - For terminal events (`completed`, `cancelled`, `failed`, `queue_timeout`),
 *   `durationMs` must be a non-negative integer.
 * - When `origin` is supplied it must be a member of {@link VALID_ORIGINS};
 *   an invalid value is treated as a logging failure (the field would
 *   otherwise leak through the index signature and break the closed
 *   taxonomy that operator dashboards rely on).
 *
 * Any validation failure or runtime emission error increments the internal
 * `logFailures` counter and returns silently. This call NEVER throws, per
 * R24.4.
 *
 * Additional fields are passed through to the JSON entry untouched so callers
 * can extend the entry shape without a breaking API change.
 *
 * Implements R24.1, R24.2, R24.3, R24.4, R30.8, R31.6, R32.3.
 *
 * @param fields - The lifecycle event fields. See {@link RequestEventFields}.
 */
export function logRequestEvent(fields: RequestEventFields): void {
  try {
    // R24.2: required-field validation. A missing/empty required field is
    // itself a logging failure: we cannot emit a compliant entry, so we bump
    // the counter and bail rather than silently writing a malformed line.
    if (
      !isNonEmptyString(fields.requestId) ||
      !isNonEmptyString(fields.clientId) ||
      !isNonEmptyString(fields.eventType)
    ) {
      logFailures += 1;
      return;
    }

    // R24.3: durationMs is required for terminal events.
    if (TERMINAL_EVENT_TYPES.has(fields.eventType) && !isNonNegativeInteger(fields.durationMs)) {
      logFailures += 1;
      return;
    }

    // R30.8 / R31.6 / R32.3: when origin is supplied it must be a
    // member of the closed taxonomy. An out-of-range origin is a
    // logging failure rather than a silent passthrough so dashboards
    // and alerts can rely on the closed set.
    if (fields.origin !== undefined && !VALID_ORIGINS.has(fields.origin)) {
      logFailures += 1;
      return;
    }

    logger.info(fields, 'request_event');
  } catch {
    // R24.4: log emission must never propagate. Bump the counter and move on.
    logFailures += 1;
  }
}

/**
 * Returns the current `logFailures` counter. Read by the `/metrics` endpoint
 * (task 4.4) to populate the `log_failures_total` Prometheus counter (R24.4).
 */
export function getLogFailures(): number {
  return logFailures;
}

/**
 * Reset the `logFailures` counter to zero.
 *
 * The leading underscore signals that this is a test-only export — production
 * code MUST NOT call it. Tests use it to isolate counter assertions between
 * cases without spinning up a fresh process.
 *
 * @internal
 */
export function _resetLogFailuresForTests(): void {
  logFailures = 0;
}

/**
 * Emit a one-off structured log entry for non-Request-lifecycle events such as
 * boot, shutdown, configuration parse errors, or auth rejections.
 *
 * The call is wrapped in `try/catch` so it satisfies the same R24.4 guarantee
 * as {@link logRequestEvent}: any emission failure bumps `logFailures` and
 * returns silently.
 *
 * @param level - One of `'info'`, `'warn'`, `'error'`.
 * @param event - Short event tag stored under the `event` field (e.g.,
 *   `'boot'`, `'shutdown'`, `'auth_rejected'`).
 * @param fields - Optional supplementary fields merged into the entry.
 */
export function logSafe(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {},
): void {
  try {
    logger[level]({ event, ...fields });
  } catch {
    logFailures += 1;
  }
}
