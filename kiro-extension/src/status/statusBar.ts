/**
 * Status-bar / panel-header state machine for the KIRO Extension.
 *
 * This module sits between the relay-client status events (input) and two
 * output sinks: the VS Code {@link vscode.StatusBarItem} and the panel-header
 * label inside the webview. It exposes a single `update`-style entrypoint
 * (`apply`) so callers don't need to know which sink reflects which state.
 *
 * Implements:
 *  - R12.8 — status-bar text is exactly one of `"disconnected"`,
 *    `"connected"`, `"streaming"`, `"queued: N"` (N 0–9999), or
 *    `"agents: M"` (M 0–999).
 *  - R22.1 — panel-header label is exactly one of `"Disconnected"`,
 *    `"Connected"`, `"Dispatched"`, `"Streaming"`, `Queued (position N)`
 *    (modeled here as `{ kind: 'Queued'; queuePosition: number }`),
 *    `"Cancelling"`, or `"Cancelled"`.
 *  - R22.2 — initial state before any session is established is
 *    `"Disconnected"`.
 *  - R22.3 — agent count and queue depth are surfaced via the status-bar
 *    text and are always the most recent values received.
 *  - R22.4 — every state-affecting event triggers a re-render synchronously
 *    (well within the 500 ms budget; see {@link StatusBarOptions.updateBudgetMs}).
 *  - R22.5 — a 5 s staleness watchdog forces `"Disconnected"` when no event
 *    has arrived.
 *  - R22.6 — after a `cancelled` terminal, the header label remains
 *    `"Cancelled"` for at least 3 s before transitioning.
 *
 * The module is pure with respect to VS Code APIs: callers inject a
 * {@link StatusBarSink} that adapts to either a real `StatusBarItem` plus
 * a webview-bridge for the header label, or to a test stub.
 */

import type { TerminalStatus } from '@kiro-gpt-bridge/shared';

/**
 * Panel-header label state per R22.1.
 *
 * The `Queued` variant carries its own `queuePosition` (the in-queue index
 * of the active request, 1-based per R22.1). Plain string variants are kept
 * as string literals so consumers can switch on them without an extra `kind`
 * check.
 */
export type HeaderLabel =
  | 'Disconnected'
  | 'Connected'
  | 'Dispatched'
  | 'Streaming'
  | { kind: 'Queued'; queuePosition: number }
  | 'Cancelling'
  | 'Cancelled';

/**
 * Status-bar text per R12.8. A free-form string at the type level — the
 * concrete alphabet enforced by the renderer is documented on
 * {@link createStatusBar}.
 */
export type StatusBarText = string;

/**
 * Output adapter. The extension supplies a real implementation that calls
 * `vscode.StatusBarItem.text = ...` and posts a `HostToWebview` message for
 * the panel header. Tests supply a stub that records calls.
 */
export interface StatusBarSink {
  /** Set the VS Code status-bar item text. */
  setStatusBarText(text: StatusBarText): void;
  /** Set the panel-header label rendered inside the webview. */
  setHeaderLabel(label: HeaderLabel): void;
}

/**
 * Lifecycle event input. Mirrors what `relayClient` / `inflight` reports:
 *
 *  - `connection`  — socket connect / disconnect.
 *  - `agents`      — registered-agent gauge update.
 *  - `queue`       — pending-queue depth update.
 *  - `request_*`   — per-request lifecycle transitions for the active
 *                    request the user submitted from this extension.
 */
export type StatusEvent =
  | { kind: 'connection'; connected: boolean }
  | { kind: 'agents'; count: number }
  | { kind: 'queue'; depth: number }
  | { kind: 'request_dispatched'; requestId: string }
  | { kind: 'request_streaming'; requestId: string }
  | { kind: 'request_queued'; requestId: string; queuePosition: number }
  | { kind: 'request_terminal'; requestId: string; terminal: TerminalStatus };

/**
 * Construction options for {@link createStatusBar}.
 */
export interface StatusBarOptions {
  /** Output sinks (status bar item + webview header). */
  sink: StatusBarSink;
  /**
   * Force `"Disconnected"` if no event arrives within this many milliseconds.
   * Implements R22.5. Default: `5_000`.
   */
  stalenessMs?: number;
  /**
   * Hold the `"Cancelled"` header label for at least this many milliseconds
   * before transitioning to whatever state is current. Implements R22.6.
   * Default: `3_000`.
   */
  cancelledHoldMs?: number;
  /**
   * Update-latency cap, documented for R22.4. The renderer is synchronous,
   * so this value is informational only — provided for completeness.
   * Default: `500`.
   */
  updateBudgetMs?: number;
  /** Clock injection for deterministic testing. Defaults to {@link Date.now}. */
  now?: () => number;
}

/**
 * Returned by {@link createStatusBar}. Push events with {@link apply} and
 * call {@link dispose} once on shutdown.
 */
export interface StatusBarManager {
  /** Push an event from `relayClient` / `inflight`. */
  apply(event: StatusEvent): void;
  /** Stop the staleness watchdog and any pending cancelled-hold timer.
   *  Idempotent — safe to call multiple times. */
  dispose(): void;
}

/** Default staleness watchdog window. R22.5. */
const DEFAULT_STALENESS_MS = 5_000;
/** Default cancelled-hold window. R22.6. */
const DEFAULT_CANCELLED_HOLD_MS = 3_000;
/** Default update-budget. R22.4 — informational. */
const DEFAULT_UPDATE_BUDGET_MS = 500;

/** Lower clamp for the status-bar `queued: N` field per R12.8. */
const QUEUE_MIN = 0;
/** Upper clamp for the status-bar `queued: N` field per R12.8. */
const QUEUE_MAX = 9999;
/** Lower clamp for the status-bar `agents: M` field per R12.8. */
const AGENTS_MIN = 0;
/** Upper clamp for the status-bar `agents: M` field per R12.8. */
const AGENTS_MAX = 999;

/**
 * Internal mutable state. Kept inside the closure of {@link createStatusBar}
 * — never exposed.
 */
interface State {
  connected: boolean;
  agents: number;
  queueDepth: number;
  activeRequest:
    | { id: string; state: 'dispatched' | 'streaming' | 'queued'; queuePosition?: number }
    | null;
  /** While `now() < cancelledUntil`, the header shows `"Cancelled"`. */
  cancelledUntil: number;
  /** Timestamp of the most recent {@link apply} call. Drives R22.5. */
  lastEventAt: number;
}

/**
 * Clamp a non-negative integer into `[lo, hi]`. Non-finite or negative
 * values collapse to `lo`; floats are floored. Used to bound the integer
 * fields rendered into the status bar text per R12.8.
 */
function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  const floored = Math.floor(n);
  if (floored < lo) return lo;
  if (floored > hi) return hi;
  return floored;
}

/**
 * Create a {@link StatusBarManager} bound to a sink.
 *
 * Render rules (R12.8 + R22.1):
 *
 *  Header label:
 *   - `!connected`                                  → `"Disconnected"`
 *   - `now() < cancelledUntil`                      → `"Cancelled"`
 *   - `activeRequest.state === 'dispatched'`        → `"Dispatched"`
 *   - `activeRequest.state === 'streaming'`         → `"Streaming"`
 *   - `activeRequest.state === 'queued'`            → `{ kind: 'Queued', queuePosition }`
 *   - else                                          → `"Connected"`
 *
 *  Status-bar text:
 *   - `!connected`                                  → `"disconnected"`
 *   - `activeRequest?.state === 'streaming'`        → `"streaming"`
 *   - `queueDepth > 0`                              → `"queued: <depth>"`
 *   - else                                          → `"agents: <count>"`
 *
 * The cancelled-hold timer (R22.6) is enforced by the `now() <
 * cancelledUntil` branch above. After a cancel, a {@link setTimeout} also
 * fires at `cancelledUntil` to trigger a re-render so the label transitions
 * automatically without a fresh event.
 *
 * The staleness watchdog (R22.5) runs every `stalenessMs / 5` ms; on each
 * tick, if `now() - lastEventAt >= stalenessMs` and the cached connection
 * state is still `true`, it flips it to `false` and re-renders.
 *
 * @param opts See {@link StatusBarOptions}.
 * @returns A {@link StatusBarManager} for use by the extension host.
 */
export function createStatusBar(opts: StatusBarOptions): StatusBarManager {
  const sink = opts.sink;
  const stalenessMs = opts.stalenessMs ?? DEFAULT_STALENESS_MS;
  const cancelledHoldMs = opts.cancelledHoldMs ?? DEFAULT_CANCELLED_HOLD_MS;
  // Documented but not actively enforced (R22.4); render() is synchronous.
  void (opts.updateBudgetMs ?? DEFAULT_UPDATE_BUDGET_MS);
  const now: () => number = opts.now ?? Date.now;

  const startedAt = now();
  const state: State = {
    connected: false,
    agents: 0,
    queueDepth: 0,
    activeRequest: null,
    cancelledUntil: 0,
    // Initialize so the watchdog doesn't fire spuriously on first tick
    // before any event has arrived (R22.2: pre-session state is
    // `"Disconnected"`, which is already the default).
    lastEventAt: startedAt,
  };

  /** Pending re-render at `cancelledUntil`; cleared on dispose / supersede. */
  let cancelledHoldTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Compute and emit the current header label and status-bar text. Idempotent
   * — safe to call as often as needed.
   */
  function render(): void {
    let header: HeaderLabel;
    if (!state.connected) {
      header = 'Disconnected';
    } else if (now() < state.cancelledUntil) {
      header = 'Cancelled';
    } else if (state.activeRequest !== null) {
      switch (state.activeRequest.state) {
        case 'dispatched':
          header = 'Dispatched';
          break;
        case 'streaming':
          header = 'Streaming';
          break;
        case 'queued': {
          const qp = state.activeRequest.queuePosition ?? 0;
          header = { kind: 'Queued', queuePosition: qp };
          break;
        }
      }
    } else {
      header = 'Connected';
    }

    let bar: StatusBarText;
    if (!state.connected) {
      bar = 'disconnected';
    } else if (state.activeRequest !== null && state.activeRequest.state === 'streaming') {
      bar = 'streaming';
    } else if (state.queueDepth > 0) {
      bar = `queued: ${clampInt(state.queueDepth, QUEUE_MIN, QUEUE_MAX)}`;
    } else {
      bar = `agents: ${clampInt(state.agents, AGENTS_MIN, AGENTS_MAX)}`;
    }

    sink.setStatusBarText(bar);
    sink.setHeaderLabel(header);
  }

  /**
   * Schedule a re-render at `cancelledUntil` so the `"Cancelled"` label
   * transitions automatically to whatever state is current after the hold,
   * even if no further event arrives. Replaces any pending hold timer.
   */
  function scheduleCancelledRelease(): void {
    if (cancelledHoldTimer !== null) {
      clearTimeout(cancelledHoldTimer);
      cancelledHoldTimer = null;
    }
    const delay = Math.max(0, state.cancelledUntil - now());
    const timer = setTimeout(() => {
      cancelledHoldTimer = null;
      render();
    }, delay);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    cancelledHoldTimer = timer;
  }

  /**
   * Update internal state for a single event, then re-render.
   *
   * For `request_terminal` with `terminal === 'cancelled'`, latches the
   * `"Cancelled"` header for `cancelledHoldMs`. For other terminals, just
   * clears the active request so the header reverts to `"Connected"`.
   */
  function apply(event: StatusEvent): void {
    state.lastEventAt = now();
    switch (event.kind) {
      case 'connection':
        state.connected = event.connected;
        if (!event.connected) {
          state.activeRequest = null;
        }
        break;
      case 'agents':
        state.agents = clampInt(event.count, AGENTS_MIN, AGENTS_MAX);
        break;
      case 'queue':
        state.queueDepth = clampInt(event.depth, QUEUE_MIN, QUEUE_MAX);
        break;
      case 'request_dispatched':
        state.activeRequest = { id: event.requestId, state: 'dispatched' };
        break;
      case 'request_streaming':
        state.activeRequest = { id: event.requestId, state: 'streaming' };
        break;
      case 'request_queued':
        state.activeRequest = {
          id: event.requestId,
          state: 'queued',
          queuePosition: clampInt(event.queuePosition, 0, QUEUE_MAX),
        };
        break;
      case 'request_terminal':
        if (event.terminal === 'cancelled') {
          state.cancelledUntil = now() + cancelledHoldMs;
          state.activeRequest = null;
          scheduleCancelledRelease();
        } else {
          state.activeRequest = null;
        }
        break;
    }
    render();
  }

  // Staleness watchdog (R22.5). Polls at `stalenessMs / 5` so we detect
  // staleness within roughly the same budget as the watchdog window itself.
  const tickMs = Math.max(1, Math.floor(stalenessMs / 5));
  const watchdog: ReturnType<typeof setInterval> = setInterval(() => {
    if (state.connected && now() - state.lastEventAt >= stalenessMs) {
      state.connected = false;
      state.activeRequest = null;
      render();
    }
  }, tickMs);
  if (typeof watchdog.unref === 'function') {
    watchdog.unref();
  }

  // Initial render reflects R22.2 — pre-session state is `"Disconnected"`.
  render();

  let disposed = false;
  /**
   * Stop the watchdog and any pending cancelled-hold timer. Idempotent.
   */
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearInterval(watchdog);
    if (cancelledHoldTimer !== null) {
      clearTimeout(cancelledHoldTimer);
      cancelledHoldTimer = null;
    }
  }

  return { apply, dispose };
}
