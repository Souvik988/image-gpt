/**
 * Inflight-request bookkeeping shared between {@link createRelayClient} and
 * the panel/status-bar layer.
 *
 * The {@link RequestRecord} type is owned by `relayClient.ts`; this module
 * re-exports it so callers don't need to reach into the client module.
 *
 * It also exposes {@link createInflightWatchdog}, a small interval-driven
 * helper that scans the inflight map every {@link InflightWatchdogOptions.intervalMs}
 * milliseconds and reports any record whose `lastChunkAt` is older than
 * 30 s while in the `'streaming'` state. This implements R16.6 — surfacing
 * stream-interrupted Requests to the user instead of silently spinning.
 *
 * Implements:
 *  - R16.6 — 30 s no-chunk watchdog flips a streaming Request into a
 *            "stream-interrupted" / cancelling state.
 *  - R21.3 — supporting helper for the relay client's reconnect loop.
 */

import type {
  ExtensionRelayClient as _ExtensionRelayClient,
  RequestRecord,
} from './relayClient.js';
import type { RequestId } from '@kiro-gpt-bridge/shared';

// Silence "imported but unused" — we only re-export the type.
export type { RequestRecord };
export type ExtensionRelayClient = _ExtensionRelayClient;

// ─── Watchdog ──────────────────────────────────────────────────────────────

/**
 * Default interval at which {@link createInflightWatchdog} scans the
 * inflight map. R16.6 only requires sub-30 s detection; 1 s gives plenty
 * of headroom and matches the heartbeat cadence used elsewhere in the
 * codebase.
 */
const DEFAULT_INTERVAL_MS = 1_000;

/**
 * Default staleness window in milliseconds. R16.6: a streaming Request
 * with no chunks for 30 s is considered stream-interrupted.
 */
const DEFAULT_STALENESS_MS = 30_000;

/**
 * Construction options for {@link createInflightWatchdog}.
 */
export interface InflightWatchdogOptions {
  /** The inflight map maintained by {@link createRelayClient}. */
  inflight: Map<RequestId, RequestRecord>;
  /**
   * Callback invoked once per stream-interrupted Request. The watchdog
   * also flips the record's state to `'cancelling'` so it doesn't fire
   * twice for the same Request.
   */
  onInterrupt: (requestId: RequestId) => void;
  /**
   * How often to scan the map. Default 1000 ms.
   */
  intervalMs?: number;
  /**
   * Staleness threshold in milliseconds. Default 30_000 (R16.6).
   */
  stalenessMs?: number;
  /** Clock injection for deterministic testing. Defaults to {@link Date.now}. */
  now?: () => number;
}

/**
 * Handle returned by {@link createInflightWatchdog}.
 */
export interface InflightWatchdog {
  /**
   * Run a single scan synchronously. Tests use this with an injected
   * `now` to drive the watchdog deterministically without relying on
   * real timers.
   */
  tick(): void;
  /**
   * Stop the periodic scan and release the timer. Idempotent.
   */
  dispose(): void;
}

/**
 * Create an interval-driven watchdog over the relay client's inflight
 * map. Every {@link InflightWatchdogOptions.intervalMs} milliseconds the
 * watchdog walks the map and, for each record whose `state === 'streaming'`
 * AND `lastChunkAt < now() - stalenessMs`, calls
 * {@link InflightWatchdogOptions.onInterrupt} with the request id and
 * flips the record's state to `'cancelling'` so the same Request is not
 * surfaced twice.
 *
 * The watchdog never throws: a faulty `onInterrupt` listener has its
 * exception swallowed so a single bad subscriber cannot leak the timer.
 *
 * @param opts See {@link InflightWatchdogOptions}.
 * @returns A {@link InflightWatchdog} handle. Callers must call
 *          {@link InflightWatchdog.dispose} on shutdown.
 */
export function createInflightWatchdog(
  opts: InflightWatchdogOptions,
): InflightWatchdog {
  const inflight = opts.inflight;
  const onInterrupt = opts.onInterrupt;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const stalenessMs = opts.stalenessMs ?? DEFAULT_STALENESS_MS;
  const now: () => number = opts.now ?? Date.now;

  /** Single scan over the inflight map. Pure given `now()`. */
  function tick(): void {
    const cutoff = now() - stalenessMs;
    for (const [requestId, rec] of inflight) {
      if (rec.state === 'streaming' && rec.lastChunkAt < cutoff) {
        // Flip state first so re-entry into tick() during the listener
        // callback does not re-fire.
        rec.state = 'cancelling';
        try {
          onInterrupt(requestId);
        } catch {
          // Swallow listener errors; the watchdog must keep running.
        }
      }
    }
  }

  const timer: ReturnType<typeof setInterval> = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
  }

  return { tick, dispose };
}
