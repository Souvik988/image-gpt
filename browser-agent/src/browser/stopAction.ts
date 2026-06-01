/**
 * Cancel-action helpers for the Browser Agent.
 *
 * Implements the browser side of R20.4: when a `Cancel_Signal` arrives for
 * an in-flight chat request, the agent must invoke ChatGPT's
 * "Stop generating" action within 2 seconds and then emit a final
 * `StreamChunk` with `status: "cancelled"` carrying any partial text that
 * has been streamed so far.
 *
 * This module is intentionally narrow: it knows how to drive the DOM and
 * how to mint a final cancelled chunk, but it does not own the partial
 * text accumulator (the stream extractor does) and it does not enforce
 * the 2 s ceiling itself (the cancel handler in `index.ts` wraps this
 * call in a `Promise.race` against a 2 s timer). The 500 ms polling cap
 * here keeps the happy path well inside that ceiling.
 */

import type { Page } from 'puppeteer';
import type { RequestId, StreamChunk } from '@kiro-gpt-bridge/shared';
import { SEL } from './selectors.js';

/**
 * Result of attempting a stop on a live ChatGPT page.
 *
 * Implements R20.4 (observability of which path the agent took — clicked
 * the visible Stop button, or fell back to keyboard Escape).
 */
export interface StopResult {
  /** True if a Stop button was clicked. False if Escape fallback was used. */
  clicked: boolean;
  /** Time the action took, in ms. */
  durationMs: number;
}

/**
 * Sleep for `ms` milliseconds. Internal helper for the polling loop.
 *
 * Resolved Promise carries no value; callers `await` for the side effect.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Maximum time (ms) we poll for a Stop button before falling back to
 * pressing Escape. Kept well below the 2 s cancel ceiling enforced by
 * the caller so a `Promise.race` timer never fires on the happy path.
 */
const STOP_POLL_BUDGET_MS = 500;

/** Inter-attempt sleep (ms) inside the Stop-button polling loop. */
const STOP_POLL_INTERVAL_MS = 50;

/**
 * Click the visible "Stop generating" button on the page. If no STOP
 * selector matches within 500 ms of polling, fall back to pressing Escape
 * via the keyboard. Either way, completes within 2 s total of being
 * called.
 *
 * Returns once the action has been triggered. Does NOT wait for the page
 * to fully settle — the stream extractor will observe the regenerate
 * button reappear and emit the final chunk.
 *
 * Each `page.$()` and `el.click()` is wrapped in try/catch so a navigated
 * or detached page does not abort the cancel attempt; the loop simply
 * advances to the next selector or to the Escape fallback. Puppeteer
 * raises `Protocol error` / `Target closed` style exceptions in those
 * cases.
 *
 * Implements R20.4.
 *
 * @param page Live puppeteer `Page` driving ChatGPT.
 * @param opts.now Time source used for the duration budget. Defaults to
 *   `Date.now`. Tests inject a deterministic clock.
 */
export async function performStopAction(
  page: Page,
  opts?: { now?: () => number },
): Promise<StopResult> {
  const now = opts?.now ?? Date.now;
  const start = now();

  // Poll up to STOP_POLL_BUDGET_MS for a visible Stop button. The selector
  // tuple is ordered most-stable to most-fragile by `selectors.ts`.
  while (now() - start < STOP_POLL_BUDGET_MS) {
    for (const selector of SEL.STOP) {
      let el: Awaited<ReturnType<Page['$']>> = null;
      try {
        el = await page.$(selector);
      } catch {
        // Page navigated or target closed mid-query — try the next
        // selector, then fall through to the Escape fallback.
        continue;
      }
      if (el === null) continue;

      try {
        await el.click();
      } catch {
        // Element became stale between query and click; advance to the
        // next selector rather than aborting the whole stop.
        continue;
      }
      return { clicked: true, durationMs: now() - start };
    }
    await sleep(STOP_POLL_INTERVAL_MS);
  }

  // No Stop button surfaced within the polling budget. Fall back to a
  // keyboard Escape, which ChatGPT also honours as a stop affordance.
  try {
    await page.keyboard.press('Escape');
  } catch {
    // Even Escape failed (page closed). Surface the duration so the
    // caller can log the attempt; the request will still be terminated
    // by the relay-side cancel timeout.
  }
  return { clicked: false, durationMs: now() - start };
}

/**
 * Build the final cancelled `StreamChunk` for a request that was cancelled.
 *
 * The chunk carries the partial text the stream extractor accumulated up
 * to the cancellation point, marks the stream complete (`isFinal: true`),
 * and tags the terminal status as `cancelled` so the relay can fan it
 * out to the originating client without further interpretation.
 *
 * Implements R20.4 (final response includes accumulated partial text).
 *
 * @param requestId Identifies the request being cancelled.
 * @param partialText Text accumulated by the stream extractor before the
 *   cancel signal arrived. Empty string is valid.
 * @param chunkIndex Next unused 0-based chunk index for this request.
 */
export function buildCancelledChunk(
  requestId: RequestId,
  partialText: string,
  chunkIndex: number,
): StreamChunk {
  return {
    protocolVersion: 1,
    requestId,
    chunkIndex,
    text: partialText,
    isFinal: true,
    status: 'cancelled',
  };
}
