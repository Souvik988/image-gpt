/**
 * ChatGPT_Pro authentication-state detection for the browser-agent.
 *
 * The agent FSM (`browser-agent/src/state/machine.ts`) calls
 * {@link detectAuthState} as a one-shot probe before each request and uses
 * {@link startAuthPoller} to re-poll while paused in `login_required`.
 *
 * Implements R8.6 (login_required detection while idle), R8.7 (login_required
 * after current request), R8.8 (re-check every 10 s while paused), R8.9
 * (resume after manual login confirmed), R23.1 (login redirect / auth-error
 * detection within 2 s of observation).
 *
 * Selectors and URL fragments are sourced from `selectors.ts` so this module
 * stays free of any hard-coded ChatGPT DOM contract.
 */

import type { Page } from 'puppeteer';
import { SEL, AUTH_URL_FRAGMENTS } from './selectors.js';

/**
 * Detected authentication state of the ChatGPT page.
 *
 * - `'login_required'`: the page is on a login landing or the login button
 *   is visible — the agent must pause request processing (R8.6, R23.1).
 * - `'ready'`: the chat composer is present — the agent can dispatch (R8.9).
 * - `'unknown'`: neither signal observed (e.g., a transient page like an
 *   interstitial) — the caller should treat this as not-yet-ready and
 *   re-probe.
 */
export type AuthState = 'login_required' | 'ready' | 'unknown';

/**
 * Subset of the puppeteer `Page` interface that {@link detectAuthState}
 * actually touches. Exported so unit tests can substitute a plain object
 * without dragging puppeteer (and a real Chromium binary) into the test
 * harness.
 */
export interface AuthDetectorPage {
  /** Current page URL — checked against {@link AUTH_URL_FRAGMENTS}. */
  url(): string;
  /** Selector probe — returns a non-null handle when the selector matches. */
  $(selector: string): Promise<unknown>;
}

/**
 * Try a single selector probe, swallowing puppeteer's mid-navigation
 * exceptions. A throw (e.g. "Execution context was destroyed because of a
 * navigation") is treated as a non-match: callers continue to the next
 * fallback selector instead of failing the whole detection. R23.1 — the
 * detection routine must be robust to login redirects happening while we
 * query the DOM.
 */
async function probe(
  page: Pick<AuthDetectorPage, '$'>,
  selector: string,
): Promise<boolean> {
  try {
    const handle = await page.$(selector);
    return handle !== null && handle !== undefined;
  } catch {
    return false;
  }
}

/**
 * Inspect the page DOM to classify its authentication state.
 *
 * Logic, in order:
 *   1. If `page.url()` contains any of {@link AUTH_URL_FRAGMENTS} →
 *      `'login_required'`.
 *   2. Else if any `SEL.LOGIN_BUTTON` selector matches → `'login_required'`.
 *   3. Else if any `SEL.INPUT` selector matches → `'ready'`.
 *   4. Else `'unknown'`.
 *
 * Each `page.$()` call is wrapped in try/catch — puppeteer can throw if the
 * page navigates mid-query. On any throw the offending selector is treated
 * as a non-match and the next fallback is tried.
 *
 * Implements R8.6 (login_required detection while idle) and R23.1 (login
 * redirect / auth-error detection).
 */
export async function detectAuthState(
  page: AuthDetectorPage | Page,
): Promise<AuthState> {
  // 1. URL match — cheapest signal, and the most reliable when the user
  //    is mid-redirect to /auth/login.
  const currentUrl: string = page.url();
  for (const fragment of AUTH_URL_FRAGMENTS) {
    if (currentUrl.includes(fragment)) {
      return 'login_required';
    }
  }

  // 2. Login button visible — the landing page renders this when the
  //    session is unauthenticated but the URL hasn't redirected yet.
  for (const selector of SEL.LOGIN_BUTTON) {
    if (await probe(page, selector)) {
      return 'login_required';
    }
  }

  // 3. Composer present — the canonical "we can submit prompts" signal.
  for (const selector of SEL.INPUT) {
    if (await probe(page, selector)) {
      return 'ready';
    }
  }

  // 4. Neither — caller should re-probe.
  return 'unknown';
}

/**
 * Handle returned by {@link startAuthPoller}. Owners (the agent FSM) call
 * `stop()` when leaving the `login_required` state so the timer doesn't
 * outlive the page.
 */
export interface AuthPoller {
  /** Stop the poll. Idempotent — safe to call multiple times. */
  stop(): void;
}

/**
 * Options accepted by {@link startAuthPoller}.
 */
export interface AuthPollerOptions {
  /**
   * Polling interval in milliseconds. Defaults to 10_000 to match the
   * 10-second cadence required by R8.8.
   */
  intervalMs?: number;
  /**
   * When `true` (the default) the poller invokes `onChange` with the very
   * first observation so the caller learns the initial state without
   * waiting a full interval. Set to `false` for callers that already know
   * the starting state.
   */
  firstReportImmediate?: boolean;
}

/**
 * Background poller that re-checks `page` every `intervalMs` and calls
 * `onChange` when the {@link AuthState} differs from the last observation.
 * The first observation is also reported (when `firstReportImmediate` is
 * true) so the caller learns the initial state without waiting.
 *
 * Implements R8.8 (re-check every 10 s while paused), R8.9 (resume on
 * confirmed `'ready'`).
 *
 * The caller (the agent state machine) owns the lifecycle: start the
 * poller when entering `'login_required'`, call `stop()` when leaving.
 * The internal `setInterval` is `unref()`'d so the poller never pins the
 * Node event loop on its own.
 *
 * @param page         The page to inspect on each tick.
 * @param onChange     Called with the new state on the first observation
 *                     (when `firstReportImmediate`) and on every subsequent
 *                     observation that differs from the last reported one.
 * @param opts         See {@link AuthPollerOptions}.
 */
export function startAuthPoller(
  page: AuthDetectorPage | Page,
  onChange: (state: AuthState) => void,
  opts?: AuthPollerOptions,
): AuthPoller {
  const intervalMs: number = opts?.intervalMs ?? 10_000;
  const firstReportImmediate: boolean = opts?.firstReportImmediate ?? true;

  let lastState: AuthState | null = null;
  let stopped = false;

  /**
   * Run one tick: probe the page, compare to {@link lastState}, and emit
   * `onChange` when changed (or unconditionally on the very first tick
   * when `firstReportImmediate`). Tick errors are swallowed so a transient
   * puppeteer throw (e.g. mid-navigation) cannot kill the poller.
   */
  async function tick(forceReport: boolean): Promise<void> {
    if (stopped) return;
    let next: AuthState;
    try {
      next = await detectAuthState(page);
    } catch {
      // detectAuthState already tolerates per-selector throws; this catch
      // is belt-and-braces for `page.url()` itself throwing (extremely
      // rare, but possible if the page is in a weird detached state).
      return;
    }
    if (stopped) return;
    if (forceReport || next !== lastState) {
      lastState = next;
      onChange(next);
    }
  }

  // First report — fire-and-forget. We deliberately do NOT await it: the
  // caller wants `startAuthPoller` to return synchronously with a handle.
  if (firstReportImmediate) {
    void tick(true);
  }

  // Recurring tick. `unref()` prevents the timer from keeping the Node
  // process alive on its own — when the agent shuts down the FSM stops
  // the poller, but if it forgets, the process can still exit cleanly.
  const handle = setInterval(() => {
    void tick(false);
  }, intervalMs);
  handle.unref();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
    },
  };
}
