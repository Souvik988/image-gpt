/**
 * Chat-driver helpers for the Browser Agent.
 *
 * Implements R9.1 (input-field discovery), R9.2 (per-keystroke jitter in
 * `human` mode, drawn uniformly from [20, 80] ms), R9.3 (Send within
 * 500 ms of typing completion), and R9.7 (`INPUT_UNAVAILABLE` failure
 * when the chat input cannot be focused inside the 5-second discovery
 * budget).
 *
 * Typing modes
 * ------------
 * The original implementation ALWAYS typed per-keystroke with 20-80 ms
 * jitter. For a 1000-character enhanced prompt that is 20-80 seconds of
 * pure typing before ChatGPT even sees the message — the single largest
 * latency cost in the whole pipeline. Two modes now exist:
 *
 *  - `'fast'` (DEFAULT): focus the input, clear it, then insert the full
 *    prompt in ONE `document.execCommand('insertText')` call. The whole
 *    insert costs ~10-50 ms regardless of length. Newlines are safe:
 *    `insertText` does not synthesize an Enter keydown, so the composer
 *    never submits early (the old bare-`keyboard.type('\n')` bug does
 *    not apply to this path).
 *  - `'human'`: the original per-keystroke jitter path, retained as an
 *    opt-in (`AGENT_TYPING_MODE=human`) for maximum stealth.
 *
 * The driver is parameterised over a small structural surface
 * ({@link ChatDriverPage}) instead of importing puppeteer's `Page`
 * directly. This keeps the unit tests and Property 16 (keystroke jitter
 * range) free of a real Chromium dependency.
 */

import { SEL } from './selectors.js';
import { logAgentEvent } from '../log/logger.js';
import type { ErrorCode, RequestId } from '@kiro-gpt-bridge/shared';

/**
 * Typing strategy. `'fast'` inserts the whole prompt via one in-page
 * `insertText` call; `'human'` synthesizes per-keystroke jitter.
 */
export type TypingMode = 'fast' | 'human';

/**
 * Per-call tuning knobs and dependency injection points for
 * {@link typeAndSubmitChat}. All fields are optional.
 */
export interface ChatDriverOptions {
  /** Typing strategy. Default `'fast'`. */
  mode?: TypingMode;
  /** Min keystroke delay ms (human mode). Default 20 (R9.2). */
  minDelayMs?: number;
  /** Max keystroke delay ms (human mode). Default 80 (R9.2). */
  maxDelayMs?: number;
  /** Selector wait budget. Default 5000 ms (R9.7). */
  inputWaitMs?: number;
  /** Random source for jitter (human mode). Default Math.random. */
  random?: () => number;
  /** Sleep injection for tests. Default setTimeout-based. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Outcome of a {@link typeAndSubmitChat} call.
 *
 * `delaysMs` is populated in `human` mode (and on partial human-mode
 * failure paths) so Property 16 can assert each value lies in
 * `[minDelayMs, maxDelayMs]`.
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
  /** The mode actually used (`'fast'` may downgrade to `'human'`). */
  modeUsed: TypingMode;
}

/**
 * Subset of puppeteer's `Page` surface used by {@link typeAndSubmitChat}.
 *
 * Defined structurally so unit tests and the Property 16 PBT can supply
 * an in-memory stub without launching a real Chromium.
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
   */
  focus?(selector: string): Promise<void>;
  /**
   * Optional: run a function in the page context. Required for the
   * `fast` typing path; when omitted the driver falls back to keyboard
   * typing.
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
 * smaller). R9.7.
 */
const PER_FALLBACK_WAIT_MS = 1000;

/**
 * Per-selector ceiling for the post-typing Send-button click. R9.3
 * requires the click to happen within 500 ms of typing completion.
 */
const SEND_CLICK_BUDGET_MS = 500;

/**
 * Type the prompt into the ChatGPT input field and submit.
 * Implements R9.1, R9.2, R9.3, R9.7.
 *
 * Behaviour, in order:
 *  1. Discover the input field by walking {@link SEL.INPUT} as fallback
 *     candidates, spending at most `inputWaitMs` total. On exhaustion,
 *     emits an `agent.error` log entry with `errorCategory:
 *     'input_unavailable'` and resolves to `{ ok: false, errorCode:
 *     'INPUT_UNAVAILABLE' }` (R9.7).
 *  2. Focus the input via three escalating strategies (click → focus →
 *     in-page evaluate), then Ctrl+A / Backspace to clear (best-effort).
 *  3. Insert the text — fast mode: one in-page `insertText` call with
 *     the entire prompt; human mode: per-keystroke with jitter drawn
 *     from the uniform distribution on `[minDelayMs, maxDelayMs]` (R9.2).
 *  4. Walk {@link SEL.SEND} as fallback Send buttons; the first one
 *     whose `click` succeeds wins. If none succeeds inside
 *     {@link SEND_CLICK_BUDGET_MS}, fall back to pressing Enter (R9.3).
 *
 * @param page Live or stubbed puppeteer page satisfying
 *   {@link ChatDriverPage}.
 * @param prompt Chat prompt, 1–32000 characters. Validated upstream by
 *   the schema layer; this function does not re-check the bounds.
 * @param requestId Originating request id used to correlate log lines
 *   with the rest of the lifecycle (R24.6).
 * @param opts See {@link ChatDriverOptions}.
 */
export async function typeAndSubmitChat(
  page: ChatDriverPage,
  prompt: string,
  requestId: RequestId,
  opts: ChatDriverOptions = {},
): Promise<ChatTypeResult> {
  const requestedMode: TypingMode = opts.mode ?? 'fast';
  const minDelay = opts.minDelayMs ?? 20;
  const maxDelay = opts.maxDelayMs ?? 80;
  const inputWait = opts.inputWaitMs ?? 5000;
  const random = opts.random ?? Math.random;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const delaysMs: number[] = [];

  // Step 1: locate the chat input via fallback selectors (R9.1, R9.7).
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
    }
  }
  if (foundSelector === null) {
    logAgentEvent({
      eventType: 'agent.error',
      errorCategory: 'input_unavailable',
      requestId,
    });
    return { ok: false, errorCode: 'INPUT_UNAVAILABLE', delaysMs: [], modeUsed: requestedMode };
  }

  // Step 2: focus + clear. Three escalating strategies: click → focus →
  // in-page evaluate (scrollIntoView + click + focus). The clear that
  // follows is best-effort.
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
      modeUsed: requestedMode,
    };
  }
  try {
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
  } catch {
    // Clearing is best-effort.
  }

  // Step 3: insert the prompt text.
  const inserted = await insertPromptText(page, prompt, requestId, requestedMode, {
    minDelay,
    maxDelay,
    random,
    sleep,
    delaysMs,
  });
  if (!inserted.ok) {
    return {
      ok: false,
      errorCode: inserted.errorCode ?? 'INPUT_UNAVAILABLE',
      message: inserted.message,
      delaysMs,
      modeUsed: inserted.modeUsed,
    };
  }

  // Step 4: click SEND within 500 ms (R9.3). Fall back to Enter.
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
        modeUsed: inserted.modeUsed,
      };
    }
  }

  logAgentEvent({
    eventType: 'agent.chat_submit',
    requestId,
    promptLength: prompt.length,
    typingMode: inserted.modeUsed,
  });
  return { ok: true, delaysMs, modeUsed: inserted.modeUsed };
}

// ─── Text insertion ─────────────────────────────────────────────────────────

interface InsertOutcome {
  ok: boolean;
  errorCode?: ErrorCode;
  message?: string;
  modeUsed: TypingMode;
}

interface InsertDeps {
  minDelay: number;
  maxDelay: number;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
  delaysMs: number[];
}

/**
 * Insert `prompt` into the focused input using the requested mode.
 *
 * Fast mode degrades gracefully: when the page surface has no
 * `evaluate`, or `execCommand('insertText')` reports failure, the driver
 * falls back to keyboard typing (chunked between newlines, no artificial
 * delay) and reports `modeUsed: 'human'`.
 */
async function insertPromptText(
  page: ChatDriverPage,
  prompt: string,
  requestId: RequestId,
  requestedMode: TypingMode,
  deps: InsertDeps,
): Promise<InsertOutcome> {
  if (requestedMode === 'fast' && typeof page.evaluate === 'function') {
    try {
      const ok = await page.evaluate((...args: unknown[]): boolean => {
        const text = args[0] as string;
        const target = document.activeElement as HTMLElement | null;
        if (target === null) return false;
        try {
          // Select any residual content first — the Ctrl+A above may have
          // been rejected by an unusual keyboard layout.
          if (target.isContentEditable || target instanceof HTMLTextAreaElement) {
            const sel = window.getSelection();
            if (sel !== null) {
              const range = document.createRange();
              range.selectNodeContents(target);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
        } catch {
          /* best effort — fall through to plain insert */
        }
        let inserted = false;
        try {
          inserted = document.execCommand('insertText', false, text);
        } catch {
          inserted = false;
        }
        if (!inserted && target instanceof HTMLTextAreaElement) {
          // Direct value write fallback for plain textareas: execCommand
          // can be a no-op in some embedded contexts.
          const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value',
          )?.set;
          try {
            setter?.call(target, text);
          } catch {
            target.value = text;
          }
          target.dispatchEvent(new Event('input', { bubbles: true }));
          inserted = true;
        }
        return inserted;
      }, prompt);
      if (ok === true) {
        return { ok: true, modeUsed: 'fast' };
      }
      logAgentEvent({
        eventType: 'agent.error',
        errorCategory: 'fast_insert_failed',
        requestId,
        note: 'execCommand returned false; falling back to keyboard typing',
      });
    } catch (e) {
      logAgentEvent({
        eventType: 'agent.error',
        errorCategory: 'fast_insert_failed',
        requestId,
        error: String(e),
        note: 'evaluate threw; falling back to keyboard typing',
      });
    }
  }

  // Human mode, or fast mode degraded to keyboard typing. Newlines are
  // submitted as Shift+Enter so the composer never fires an early submit
  // (a bare keyboard.type('\n') synthesizes Enter — the original R9.3
  // bug). Carriage returns are skipped so CRLF does not double-insert.
  const span = deps.maxDelay - deps.minDelay;
  const humanized = requestedMode === 'human';
  for (const ch of prompt) {
    if (humanized) {
      const delay = deps.minDelay + deps.random() * span;
      deps.delaysMs.push(delay);
      await deps.sleep(delay);
    }
    try {
      if (ch === '\n') {
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
      } else if (ch === '\r') {
        // Skip — CRLF sequences must not double-insert newlines. The
        // jitter delay was still recorded above so the per-code-point
        // keystroke-count invariant (Property 16) holds in human mode.
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
      return { ok: false, errorCode: 'INPUT_UNAVAILABLE', message: String(e), modeUsed: humanized ? 'human' : 'fast' };
    }
  }
  return { ok: true, modeUsed: humanized ? 'human' : 'fast' };
}
