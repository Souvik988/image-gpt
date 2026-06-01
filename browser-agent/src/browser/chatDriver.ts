/**
 * Chat-driver helpers for the Browser Agent.
 *
 * Implements R9.1 (input-field discovery), R9.2 (per-keystroke jitter
 * drawn uniformly from [20, 80] ms), R9.3 (Send within 500 ms of typing
 * completion), and R9.7 (`INPUT_UNAVAILABLE` failure when the chat input
 * cannot be focused inside the 5-second discovery budget).
 *
 * The driver is parameterised over a small structural surface
 * ({@link ChatDriverPage}) instead of importing puppeteer's `Page`
 * directly. This keeps the unit tests and Property 16 (keystroke jitter
 * range, task 12.4) free of a real Chromium dependency: callers can pass
 * a JSDOM-flavoured stub or an in-memory mock that satisfies the
 * narrower interface.
 *
 * The function records every inter-keystroke delay in
 * {@link ChatTypeResult.delaysMs} so the property test can assert each
 * value lies in `[minDelayMs, maxDelayMs]` without instrumenting the
 * `sleep` injection separately.
 */

import { SEL } from './selectors.js';
import { logAgentEvent } from '../log/logger.js';
import type { ErrorCode, RequestId } from '@kiro-gpt-bridge/shared';

/**
 * Per-call tuning knobs and dependency injection points for
 * {@link typeAndSubmitChat}. All fields are optional and default to the
 * production values fixed by R9.2 / R9.7.
 */
export interface ChatDriverOptions {
  /** Min keystroke delay ms. Default 20 (R9.2). */
  minDelayMs?: number;
  /** Max keystroke delay ms. Default 80 (R9.2). */
  maxDelayMs?: number;
  /** Selector wait budget. Default 5000 ms (R9.7). */
  inputWaitMs?: number;
  /** Random source for jitter. Default Math.random. */
  random?: () => number;
  /** Sleep injection for tests. Default setTimeout-based. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Outcome of a {@link typeAndSubmitChat} call.
 *
 * `delaysMs` is populated even on failure paths that occur after at
 * least one keystroke, so Property 16 can examine the jitter
 * distribution from any partial run.
 */
export interface ChatTypeResult {
  /** True when the prompt was typed and the Send action was triggered. */
  ok: boolean;
  /** Closed-enum failure code from the wire taxonomy when `ok === false`. */
  errorCode?: ErrorCode;
  /** Human-readable supplement for diagnostics; never user-facing copy. */
  message?: string;
  /** Recorded keystroke delays in order, for Property 16 verification. */
  delaysMs: number[];
}

/**
 * Subset of puppeteer's `Page` surface used by {@link typeAndSubmitChat}.
 *
 * Defined structurally so unit tests and the Property 16 PBT can supply
 * an in-memory stub without launching a real Chromium. The shape is a
 * strict subset of `import('puppeteer').Page` — production code passes
 * the puppeteer page directly and structural typing accepts it.
 */
export interface ChatDriverPage {
  /** Wait until `selector` resolves or the timeout elapses. */
  waitForSelector(selector: string, opts: { timeout: number }): Promise<unknown>;
  /** Resolve a single matching element, or `null` if none. */
  $(selector: string): Promise<unknown>;
  /** Click the first element matching `selector`. */
  click(selector: string): Promise<void>;
  /**
   * Optional: focus a selector directly (no actionability checks).
   * Production puppeteer pages provide this; test stubs may omit it.
   */
  focus?(selector: string): Promise<void>;
  /**
   * Optional: run a function in the page context. Used as a last-resort
   * focus fallback when `click`/`focus` are blocked by an overlay.
   * Production puppeteer pages provide this; test stubs may omit it.
   */
  evaluate?<R>(fn: (...args: unknown[]) => R | Promise<R>, ...args: unknown[]): Promise<R>;
  /** Low-level keyboard control surface. */
  keyboard: {
    /** Press and hold a modifier or key. */
    down(key: string): Promise<void>;
    /** Release a previously held modifier or key. */
    up(key: string): Promise<void>;
    /** Tap a single key (down then up). */
    press(key: string): Promise<void>;
    /** Synthesize printable-character keystrokes. */
    type(text: string, opts?: { delay?: number }): Promise<void>;
  };
  /** Convenience: focus a selector and synthesize text input. */
  type(selector: string, text: string, opts?: { delay?: number }): Promise<void>;
}

/**
 * Per-fallback `waitForSelector` ceiling. The discovery loop walks
 * {@link SEL.INPUT} in order and gives each candidate at most this many
 * milliseconds (or the remaining `inputWaitMs` budget, whichever is
 * smaller). Keeping the per-attempt window short means a missing primary
 * selector does not consume the entire 5 s budget. R9.7.
 */
const PER_FALLBACK_WAIT_MS = 1000;

/**
 * Per-selector ceiling for the post-typing Send-button click. R9.3
 * requires the click to happen within 500 ms of typing completion;
 * walking three fallbacks at ~150 ms each keeps the loop comfortably
 * inside that budget.
 */
const SEND_CLICK_BUDGET_MS = 500;

/**
 * Type the prompt into the ChatGPT_Pro input field with human-like
 * keystroke jitter, then submit. Implements R9.1, R9.2, R9.3, R9.7.
 *
 * Behaviour, in order:
 *  1. Discover the input field by walking {@link SEL.INPUT} as fallback
 *     candidates, spending at most `inputWaitMs` total. On exhaustion,
 *     emits an `agent.error` log entry with `errorCategory:
 *     'input_unavailable'` and resolves to `{ ok: false, errorCode:
 *     'INPUT_UNAVAILABLE' }` (R9.7).
 *  2. Click the input to focus it, then issue Ctrl+A / Backspace to
 *     clear any pre-existing text. Clearing is best-effort — a failure
 *     here does not abort the call.
 *  3. For each character of `prompt`, sleep for a delay drawn from the
 *     uniform distribution on `[minDelayMs, maxDelayMs]`, then synthesize
 *     the keystroke. Every drawn delay is appended to
 *     {@link ChatTypeResult.delaysMs} (R9.2).
 *  4. Walk {@link SEL.SEND} as fallback Send buttons; the first one
 *     whose `click` succeeds wins. If none succeeds inside
 *     {@link SEND_CLICK_BUDGET_MS}, fall back to pressing Enter (R9.3).
 *
 * @param page Live or stubbed puppeteer page satisfying
 *   {@link ChatDriverPage}. Production callers pass the real page; the
 *   Property 16 PBT passes an in-memory mock.
 * @param prompt Chat prompt, 1–32000 characters. Validated upstream by
 *   the schema layer; this function does not re-check the bounds.
 * @param requestId Originating request id used to correlate log lines
 *   with the rest of the lifecycle (R24.6).
 * @param opts See {@link ChatDriverOptions}. Tests override `random`
 *   and `sleep` to make the call fully deterministic.
 */
export async function typeAndSubmitChat(
  page: ChatDriverPage,
  prompt: string,
  requestId: RequestId,
  opts: ChatDriverOptions = {},
): Promise<ChatTypeResult> {
  const minDelay = opts.minDelayMs ?? 20;
  const maxDelay = opts.maxDelayMs ?? 80;
  const inputWait = opts.inputWaitMs ?? 5000;
  const random = opts.random ?? Math.random;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const delaysMs: number[] = [];

  // Step 1: locate the chat input via fallback selectors (R9.1, R9.7).
  // Each candidate gets the smaller of PER_FALLBACK_WAIT_MS and the
  // remaining 5 s budget so the total time spent in discovery never
  // exceeds `inputWait`.
  let foundSelector: string | null = null;
  const discoveryStart = Date.now();
  for (const selector of SEL.INPUT) {
    const elapsed = Date.now() - discoveryStart;
    const remaining = inputWait - elapsed;
    if (remaining <= 0) break;
    const attemptTimeout = Math.min(remaining, PER_FALLBACK_WAIT_MS);
    try {
      const handle = await page.waitForSelector(selector, { timeout: attemptTimeout });
      if (handle !== null && handle !== undefined) {
        foundSelector = selector;
        break;
      }
    } catch {
      // Selector did not surface within its slice of the budget.
      // Advance to the next fallback.
    }
  }
  if (foundSelector === null) {
    logAgentEvent({
      eventType: 'agent.error',
      errorCategory: 'input_unavailable',
      requestId,
    });
    return { ok: false, errorCode: 'INPUT_UNAVAILABLE', delaysMs };
  }

  // Step 2: focus + clear. Focus is mandatory (we cannot type without
  // it), but we try three escalating strategies before giving up:
  //   (a) page.click — the normal path, but puppeteer's actionability
  //       checks can reject it when a subtle overlay or the ProseMirror
  //       composer's wrapper intercepts the hit-test.
  //   (b) page.focus — focuses the node directly, skipping the
  //       visible/in-viewport/uncovered hit-test that click enforces.
  //   (c) page.evaluate — last resort: call .focus() in-page and
  //       dispatch a synthetic click so any focus listeners still fire.
  // The clear that follows is best-effort.
  let focused = false;
  let lastFocusErr: unknown = null;
  try {
    await page.click(foundSelector);
    focused = true;
  } catch (e) {
    lastFocusErr = e;
  }
  if (!focused && typeof page.focus === 'function') {
    try {
      await page.focus(foundSelector);
      focused = true;
    } catch (e) {
      lastFocusErr = e;
    }
  }
  if (!focused && typeof page.evaluate === 'function') {
    try {
      const ok = await page.evaluate((...args: unknown[]): boolean => {
        const sel = args[0] as string;
        const el = document.querySelector(sel);
        if (el === null) return false;
        const node = el as HTMLElement;
        try {
          node.scrollIntoView({ block: 'center' });
        } catch {
          /* non-fatal */
        }
        try {
          node.click();
        } catch {
          /* non-fatal — focus is what matters */
        }
        node.focus();
        return document.activeElement === node;
      }, foundSelector);
      if (ok === true) focused = true;
    } catch (e) {
      lastFocusErr = e;
    }
  }
  if (!focused) {
    logAgentEvent({
      eventType: 'agent.error',
      errorCategory: 'input_focus_failed',
      requestId,
      error: String(lastFocusErr),
    });
    return {
      ok: false,
      errorCode: 'INPUT_UNAVAILABLE',
      message: 'failed to focus input',
      delaysMs,
    };
  }
  try {
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
  } catch {
    // Clearing is best-effort. A stale page or unusual keyboard layout
    // may reject one of these strokes; we continue rather than bailing.
  }

  // Step 3: type with per-keystroke jitter (R9.2). Iterate code points
  // via for..of so surrogate pairs (emoji, etc.) are typed as single
  // logical characters. Each delay is drawn before the keystroke and
  // recorded in `delaysMs` for Property 16.
  const span = maxDelay - minDelay;
  for (const ch of prompt) {
    const delay = minDelay + random() * span;
    delaysMs.push(delay);
    await sleep(delay);
    try {
      if (ch === '\n') {
        // Soft newline: Shift+Enter inserts a line break in the
        // ProseMirror composer instead of submitting the message. A bare
        // keyboard.type('\n') synthesizes Enter, which ChatGPT treats as
        // submit — that fired the prompt after only the first line of a
        // multi-line (prompt-enhanced) prompt had been typed (R9.3).
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
      } else if (ch === '\r') {
        // Skip carriage returns so CRLF sequences do not double-insert
        // newlines. The jitter delay was still recorded above so the
        // per-code-point keystroke-count invariant (Property 16) holds.
      } else {
        await page.keyboard.type(ch);
      }
    } catch (e) {
      logAgentEvent({
        eventType: 'agent.error',
        errorCategory: 'type_failed',
        requestId,
        error: String(e),
      });
      return {
        ok: false,
        errorCode: 'INPUT_UNAVAILABLE',
        message: String(e),
        delaysMs,
      };
    }
  }

  // Step 4: click SEND within 500 ms (R9.3). Fall back to Enter if no
  // SEND selector clicks cleanly — ChatGPT_Pro accepts Enter as a
  // submit affordance on the composer.
  let sent = false;
  const sendStart = Date.now();
  for (const selector of SEL.SEND) {
    if (Date.now() - sendStart > SEND_CLICK_BUDGET_MS) break;
    try {
      await page.click(selector);
      sent = true;
      break;
    } catch {
      // Try next fallback.
    }
  }
  if (!sent) {
    try {
      await page.keyboard.press('Enter');
      sent = true;
    } catch (e) {
      logAgentEvent({
        eventType: 'agent.error',
        errorCategory: 'send_failed',
        requestId,
        error: String(e),
      });
      return {
        ok: false,
        errorCode: 'INPUT_UNAVAILABLE',
        message: 'send button not clickable',
        delaysMs,
      };
    }
  }

  logAgentEvent({
    eventType: 'agent.chat_submit',
    requestId,
    promptLength: prompt.length,
  });
  return { ok: true, delaysMs };
}
