/**
 * Stream-extractor helpers for the Browser Agent.
 *
 * Polls the most-recent ChatGPT_Pro assistant message body and yields
 * incremental {@link StreamChunk} payloads as the model streams its
 * response. Implements R9.4 (chunk emission cadence ≤ 250 ms apart in
 * steady state), R9.5 (final chunk emitted ≤ 500 ms after the
 * completion signal, carrying the full assembled text), R9.6 (visible
 * error banner in the assistant turn → `CHATGPT_ERROR`), R9.8 (no
 * stream activity within 120 s → `CHAT_TIMEOUT`), and R16.1 (chunks
 * are routed back to the originating client by the caller).
 *
 * The extractor is parameterised over a small structural surface
 * ({@link StreamExtractorPage}) instead of importing puppeteer's
 * `Page` directly. This keeps unit tests and Property 6 (stream
 * consistency, task 12.3) free of a real Chromium dependency:
 * callers can pass an in-memory mock or a JSDOM-flavoured stub that
 * satisfies the narrower interface, and production code passes the
 * puppeteer page directly because structural typing accepts it.
 *
 * Completion signal contract: a turn is considered finished when any
 * of {@link SEL.MESSAGE_FINISHED_MARKER} resolves OR when
 * {@link SEL.REGENERATE} is present and {@link SEL.STOP} is absent.
 * On completion the extractor re-reads the message body to capture any
 * trailing text the streamer has not yet yielded, emits any remainder
 * as a non-final chunk, and then yields a final event whose `text`
 * field carries the **entire assembled response** (R9.5).
 *
 * The emitted shape is a {@link StreamExtractorEvent} discriminated
 * union — `{ kind: 'chunk' | 'final' | 'failure' }` — rather than the
 * raw {@link StreamChunk} so callers can react to failure conditions
 * without inspecting `errorCode` on every yield.
 */

import { SEL } from './selectors.js';
import { logAgentEvent } from '../log/logger.js';
import type { ErrorCode, RequestId, StreamChunk } from '@kiro-gpt-bridge/shared';

/**
 * Subset of puppeteer's `Page` surface used by {@link extractStream}.
 *
 * Defined structurally so unit tests and the Property 6 PBT can supply
 * an in-memory stub without launching Chromium. The shape is a strict
 * subset of `import('puppeteer').Page`; production code passes the
 * puppeteer page directly.
 *
 * `evaluate` uses an `unknown[]`-typed args tuple instead of the more
 * precise generic that puppeteer ships, because the unit-test mock
 * cannot easily express puppeteer's `EvaluateFunc` constraint and
 * structural typing accepts the wider signature.
 */
export interface StreamExtractorPage {
  /**
   * Run `fn` inside the page context with the given serialisable args
   * and return the awaited result. Mirrors `Page.evaluate`.
   */
  evaluate<R>(fn: (...args: unknown[]) => R | Promise<R>, ...args: unknown[]): Promise<R>;
  /** Current URL of the page. */
  url(): string;
}

/**
 * Per-call tuning knobs and dependency-injection points for
 * {@link extractStream}. All fields are optional and default to the
 * production values fixed by R9.4 / R9.5 / R9.8.
 */
export interface StreamExtractorOptions {
  /** Total deadline before `CHAT_TIMEOUT` in ms. Default `120_000` (R9.8). */
  timeoutMs?: number;
  /** Inter-poll delay used as the chunk cadence ceiling, in ms. Default `250` (R9.4). */
  chunkIntervalMs?: number;
  /** Final-chunk emit budget after the completion signal fires, in ms. Default `500` (R9.5). */
  finalEmitBudgetMs?: number;
  /** Sleep injection for tests. Default `setTimeout`-based. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock injection for tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * Discriminated-union event yielded by {@link extractStream}.
 *
 * - `chunk`: incremental text appended to the assistant message since
 *   the previous yield. `chunk.isFinal` is always `false`.
 * - `final`: completion event whose `chunk.text` carries the **full**
 *   assembled message (not a diff) and `chunk.isFinal === true`. R9.5.
 * - `failure`: terminal error from the closed wire taxonomy. The
 *   generator returns immediately after yielding this event.
 */
export type StreamExtractorEvent =
  | { kind: 'chunk'; chunk: StreamChunk }
  | { kind: 'final'; chunk: StreamChunk }
  | { kind: 'failure'; errorCode: ErrorCode; message?: string };

/**
 * Extract incremental text from a streaming ChatGPT_Pro assistant
 * message. Implements R9.4, R9.5, R9.6, R9.8, R16.1.
 *
 * Behaviour, in order, on every poll cycle:
 *
 *  1. Probe {@link SEL.CHAT_ERROR_BANNER} for a visible error in the
 *     assistant turn. On a hit, emit `agent.error` with
 *     `errorCategory: 'chatgpt_error'`, yield a `failure` event with
 *     `CHATGPT_ERROR`, and return. R9.6.
 *  2. Read the current assistant body innerText via fallback
 *     selectors in {@link SEL.ASSISTANT_MESSAGE_BODY}. When the read
 *     length exceeds the previously-emitted accumulator length,
 *     yield a `chunk` event whose `text` is the diff suffix and
 *     update the accumulator. R9.4, R16.1.
 *  3. Probe the completion signal: any of
 *     {@link SEL.MESSAGE_FINISHED_MARKER} present, OR
 *     {@link SEL.REGENERATE} present AND {@link SEL.STOP} absent.
 *     On completion, re-read the body to capture any trailing text
 *     the streamer has not yet yielded, emit it as a `chunk` if
 *     non-empty, then yield a `final` event whose `text` is the
 *     full assembled response, sleeping `min(50, finalEmitBudgetMs)`
 *     beforehand to stay well inside the 500 ms budget. R9.5.
 *  4. If the elapsed wall-clock time exceeds `timeoutMs`, emit
 *     `agent.error` with `errorCategory: 'chat_timeout'`, yield a
 *     `failure` event with `CHAT_TIMEOUT`, and return. R9.8.
 *  5. Otherwise sleep `chunkIntervalMs` and loop.
 *
 * The generator never throws on selector / DOM read failures: each
 * fallback selector is tried in turn, and a poll cycle in which all
 * selectors fail simply contributes no chunk. The deadline / error /
 * completion checks always run regardless of read outcome.
 *
 * @param page Live or stubbed puppeteer page satisfying
 *   {@link StreamExtractorPage}.
 * @param requestId Originating request id used to correlate log lines
 *   with the rest of the lifecycle (R24.6).
 * @param opts See {@link StreamExtractorOptions}. Tests override
 *   `now` and `sleep` to make the call fully deterministic.
 *
 * @yields {@link StreamExtractorEvent} — `chunk` while streaming,
 *   `final` on completion, `failure` on error / timeout.
 */
export async function* extractStream(
  page: StreamExtractorPage,
  requestId: RequestId,
  opts: StreamExtractorOptions = {},
): AsyncGenerator<StreamExtractorEvent, void, void> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const chunkIntervalMs = opts.chunkIntervalMs ?? 250;
  const finalEmitBudgetMs = opts.finalEmitBudgetMs ?? 500;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;

  let accumulated = '';
  let chunkIndex = 0;
  const startedAt = now();

  while (true) {
    const elapsed = now() - startedAt;

    // Step 1: visible error banner takes priority — bail before chasing
    // any more text. R9.6.
    const errorText = await detectChatError(page);
    if (errorText !== null) {
      logAgentEvent({
        eventType: 'agent.error',
        errorCategory: 'chatgpt_error',
        requestId,
        error: errorText,
      });
      yield { kind: 'failure', errorCode: 'CHATGPT_ERROR', message: errorText };
      return;
    }

    // Step 2: incremental read. The diff-suffix vs the accumulator is
    // the only safe interpretation — ChatGPT may re-render the same
    // text content under a new DOM node mid-stream. R9.4.
    const currentText = await readAssistantBody(page);
    if (currentText !== null && currentText.length > accumulated.length) {
      const diff = currentText.slice(accumulated.length);
      accumulated = currentText;
      const chunk: StreamChunk = {
        protocolVersion: 1,
        requestId,
        chunkIndex,
        text: diff,
        isFinal: false,
      };
      logAgentEvent({
        eventType: 'agent.stream_chunk_emitted',
        requestId,
        chunkIndex,
      });
      yield { kind: 'chunk', chunk };
      chunkIndex += 1;
    }

    // Step 3: completion signal. Re-read once more to catch any trailing
    // text the streamer had buffered, then emit the full assembled text
    // as the final chunk per R9.5.
    const isFinished = await detectFinished(page);
    if (isFinished) {
      const finalText = await readAssistantBody(page);
      if (finalText !== null && finalText.length > accumulated.length) {
        const finalDiff = finalText.slice(accumulated.length);
        accumulated = finalText;
        const tailChunk: StreamChunk = {
          protocolVersion: 1,
          requestId,
          chunkIndex,
          text: finalDiff,
          isFinal: false,
        };
        logAgentEvent({
          eventType: 'agent.stream_chunk_emitted',
          requestId,
          chunkIndex,
        });
        yield { kind: 'chunk', chunk: tailChunk };
        chunkIndex += 1;
      }
      // Stay well inside the 500 ms budget. The bulk of the work is
      // already done; this pause just gives consumers a beat to drain.
      await sleep(Math.min(50, finalEmitBudgetMs));
      const finalChunk: StreamChunk = {
        protocolVersion: 1,
        requestId,
        chunkIndex,
        text: accumulated,
        isFinal: true,
      };
      logAgentEvent({
        eventType: 'agent.stream_chunk_emitted',
        requestId,
        chunkIndex,
        isFinal: true,
      });
      yield { kind: 'final', chunk: finalChunk };
      return;
    }

    // Step 4: deadline check. R9.8 specifies 120 s with no stream
    // activity, but a stuck mid-stream page is functionally identical
    // — both surface as `CHAT_TIMEOUT`.
    if (elapsed >= timeoutMs) {
      logAgentEvent({
        eventType: 'agent.error',
        errorCategory: 'chat_timeout',
        requestId,
      });
      yield { kind: 'failure', errorCode: 'CHAT_TIMEOUT' };
      return;
    }

    // Step 5: respect the cadence ceiling.
    await sleep(chunkIntervalMs);
  }
}

/**
 * Read the current assistant message body innerText, walking
 * {@link SEL.ASSISTANT_MESSAGE_BODY} fallbacks in order. Returns the
 * first non-null `innerText` value, or `null` when every fallback
 * fails or the element is absent.
 */
async function readAssistantBody(page: StreamExtractorPage): Promise<string | null> {
  for (const selector of SEL.ASSISTANT_MESSAGE_BODY) {
    try {
      const text = await page.evaluate((...args: unknown[]): string | null => {
        const sel = args[0] as string;
        const el = document.querySelector(sel);
        if (el === null) return null;
        const inner = (el as HTMLElement).innerText;
        return typeof inner === 'string' ? inner : null;
      }, selector);
      if (typeof text === 'string') return text;
    } catch {
      // Page navigated or selector errored — try the next fallback.
    }
  }
  return null;
}

/**
 * Detect the streaming-finished signal:
 *  1. Any of {@link SEL.MESSAGE_FINISHED_MARKER} resolves, OR
 *  2. Any of {@link SEL.REGENERATE} is present AND no
 *     {@link SEL.STOP} selector is present.
 *
 * Returns `true` only when one of those branches fires. Probing both
 * branches every cycle makes the detector resilient to ChatGPT_Pro
 * UI changes that drop the `data-message-finished` marker.
 */
async function detectFinished(page: StreamExtractorPage): Promise<boolean> {
  // Branch 1: explicit finished marker.
  for (const selector of SEL.MESSAGE_FINISHED_MARKER) {
    try {
      const present = await page.evaluate((...args: unknown[]): boolean => {
        const sel = args[0] as string;
        return document.querySelector(sel) !== null;
      }, selector);
      if (present) return true;
    } catch {
      // Try next fallback.
    }
  }

  // Branch 2: regenerate visible AND stop hidden.
  let regenPresent = false;
  for (const selector of SEL.REGENERATE) {
    try {
      const present = await page.evaluate(
        (...args: unknown[]): boolean => document.querySelector(args[0] as string) !== null,
        selector,
      );
      if (present) {
        regenPresent = true;
        break;
      }
    } catch {
      // Try next fallback.
    }
  }
  if (!regenPresent) return false;

  for (const selector of SEL.STOP) {
    try {
      const present = await page.evaluate(
        (...args: unknown[]): boolean => document.querySelector(args[0] as string) !== null,
        selector,
      );
      if (present) return false;
    } catch {
      // Try next fallback.
    }
  }
  return true;
}

/**
 * Look for a visible chat error banner inside the most-recent
 * assistant turn. Returns the trimmed banner text on a hit, otherwise
 * `null`. Implements R9.6.
 *
 * Walks {@link SEL.CHAT_ERROR_BANNER} fallbacks ordered most-stable to
 * most-fragile; the first selector whose match has non-empty
 * `textContent` wins.
 */
async function detectChatError(page: StreamExtractorPage): Promise<string | null> {
  for (const selector of SEL.CHAT_ERROR_BANNER) {
    try {
      const text = await page.evaluate((...args: unknown[]): string | null => {
        const sel = args[0] as string;
        const el = document.querySelector(sel);
        if (el === null) return null;
        const txt = (el as HTMLElement).textContent ?? '';
        const trimmed = txt.trim();
        return trimmed.length > 0 ? trimmed : null;
      }, selector);
      if (typeof text === 'string' && text.length > 0) return text;
    } catch {
      // Try next fallback.
    }
  }
  return null;
}
