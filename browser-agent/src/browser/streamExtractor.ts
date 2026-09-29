/**
 * Stream-extractor for the Browser Agent.
 *
 * Polls the most-recent ChatGPT assistant message via the single-round-
 * trip {@link readLastTurnState} reader and yields incremental
 * {@link StreamChunk} payloads as the model streams its response.
 *
 * Implements:
 *  - R9.4  chunk cadence ≤ 250 ms apart in steady state (default poll
 *          interval 150 ms — one CDP round-trip per tick).
 *  - R9.5  final chunk emitted ≤ 500 ms after the completion signal,
 *          carrying the full assembled text.
 *  - R9.6  visible error in the assistant turn → `CHATGPT_ERROR`.
 *  - R9.8  timeout handling — **idle-based**: the deadline counts time
 *          since the last observed text growth, not total wall-clock.
 *          The original implementation measured total elapsed time and
 *          killed actively-streaming long responses at 120 s. A separate
 *          total cap (`totalTimeoutMs`) still bounds runaway requests.
 *  - R16.1 chunks routed back to the originating client by the caller.
 *
 * Multi-turn correctness
 * ---------------------
 * Before the prompt is submitted the caller captures a
 * {@link StreamBaseline} (turn count + last-turn text). The extractor
 * only streams text from turns that appear AFTER the baseline:
 *
 *  - `turnCount > baseline.turnCount` → the new response turn exists;
 *    stream its text.
 *  - `turnCount === baseline.turnCount && text !== baseline.lastText` →
 *    the conversation was reset (new chat) and re-rendered; accept the
 *    divergent turn as the new response.
 *  - otherwise → the response has not started rendering yet; keep
 *    waiting (this is the phase where the old implementation would read
 *    a PREVIOUS turn's complete text and emit bogus instant chunks).
 *
 * @packageDocumentation
 */

import { logAgentEvent } from '../log/logger.js';
import {
  readLastTurnState,
  captureStreamBaseline,
  type LastTurnState,
  type StreamBaseline,
  type TurnReaderPage,
} from './turnReader.js';
import type { ErrorCode, RequestId, StreamChunk } from '@kiro-gpt-bridge/shared';

export type { StreamBaseline } from './turnReader.js';

/**
 * Per-call tuning knobs and dependency-injection points for
 * {@link extractStream}. All fields are optional.
 */
export interface StreamExtractorOptions {
  /**
   * Idle deadline in ms: fail with `CHAT_TIMEOUT` after this much time
   * with NO text growth. Default `120_000` (R9.8, re-interpreted as an
   * idle budget).
   */
  idleTimeoutMs?: number;
  /**
   * Total wall-clock cap in ms regardless of activity. Default
   * `600_000` — a request that is actively streaming for ten minutes is
   * pathological and should surface as a failure.
   */
  totalTimeoutMs?: number;
  /** Inter-poll delay in ms. Default `150` (R9.4 cadence ceiling 250). */
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
 * Convenience wrapper: capture the pre-submit baseline in one call.
 * Returns `null` when the page is unreachable — callers should treat
 * that as `CHATGPT_UNAVAILABLE` and not submit.
 */
export async function captureBaseline(
  page: TurnReaderPage,
): Promise<StreamBaseline | null> {
  return captureStreamBaseline(page);
}

/**
 * Extract incremental text from a streaming ChatGPT assistant message.
 *
 * Behaviour, in order, on every poll cycle:
 *
 *  1. Read one {@link LastTurnState} snapshot (single evaluate).
 *  2. If a visible error is present in the new turn, emit `agent.error`
 *     with `errorCategory: 'chatgpt_error'`, yield a `failure` event
 *     with `CHATGPT_ERROR`, and return. R9.6.
 *  3. If the new response turn has started (see module docs), diff its
 *     text against the accumulator and yield `chunk` events. R9.4.
 *  4. If the turn is finished, re-read once more to capture trailing
 *     text, emit it, then yield a `final` event carrying the full
 *     assembled response. R9.5.
 *  5. Deadline checks: idle budget since last growth (`CHAT_TIMEOUT`),
 *     then total wall-clock cap (`CHAT_TIMEOUT`). R9.8.
 *  6. Sleep `chunkIntervalMs` and loop.
 *
 * The generator never throws on selector / DOM read failures: a cycle in
 * which the snapshot is `null` simply contributes no chunk.
 *
 * @param page Live or stubbed puppeteer page.
 * @param requestId Originating request id used to correlate log lines
 *   with the rest of the lifecycle (R24.6).
 * @param baseline Pre-submit snapshot from {@link captureBaseline}.
 * @param opts See {@link StreamExtractorOptions}. Tests override `now`
 *   and `sleep` to make the call fully deterministic.
 *
 * @yields {@link StreamExtractorEvent} — `chunk` while streaming,
 *   `final` on completion, `failure` on error / timeout.
 */
export async function* extractStream(
  page: TurnReaderPage,
  requestId: RequestId,
  baseline: StreamBaseline,
  opts: StreamExtractorOptions = {},
): AsyncGenerator<StreamExtractorEvent, void, void> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
  const totalTimeoutMs = opts.totalTimeoutMs ?? 600_000;
  const chunkIntervalMs = opts.chunkIntervalMs ?? 150;
  const finalEmitBudgetMs = opts.finalEmitBudgetMs ?? 500;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;

  let accumulated = '';
  let chunkIndex = 0;
  let lastGrowthAt = now();
  const startedAt = lastGrowthAt;

  while (true) {
    const state = await readLastTurnState(page);

    if (state !== null) {
      // Step 2: visible error in the NEW turn takes priority. Errors in
      // pre-existing turns are not this request's failures.
      if (state.turnCount > baseline.turnCount && state.errorText !== null) {
        logAgentEvent({
          eventType: 'agent.error',
          errorCategory: 'chatgpt_error',
          requestId,
          error: state.errorText,
        });
        yield { kind: 'failure', errorCode: 'CHATGPT_ERROR', message: state.errorText };
        return;
      }

      // Step 3: has the new response turn started rendering?
      const newTurnArrived =
        state.turnCount > baseline.turnCount ||
        (state.turnCount === baseline.turnCount &&
          baseline.turnCount > 0 &&
          state.text !== baseline.lastText);

      if (newTurnArrived && state.text.length > accumulated.length) {
        const diff = state.text.slice(accumulated.length);
        accumulated = state.text;
        lastGrowthAt = now();
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

      // Step 4: completion signal (only meaningful once the new turn exists).
      if (newTurnArrived && state.finished) {
        // Re-read once more to catch any trailing text buffered by the
        // streamer between the last poll and the finished signal.
        const finalState = await readLastTurnState(page);
        const finalText = finalState?.text ?? accumulated;
        if (finalText.length > accumulated.length) {
          const tailDiff = finalText.slice(accumulated.length);
          accumulated = finalText;
          const tailChunk: StreamChunk = {
            protocolVersion: 1,
            requestId,
            chunkIndex,
            text: tailDiff,
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
    }

    // Step 5: deadline checks. Idle budget counts from the last observed
    // text growth; the total cap bounds pathological endless streams.
    const current = now();
    if (current - lastGrowthAt >= idleTimeoutMs) {
      logAgentEvent({
        eventType: 'agent.error',
        errorCategory: 'chat_timeout',
        requestId,
        idleMs: current - lastGrowthAt,
      });
      yield { kind: 'failure', errorCode: 'CHAT_TIMEOUT' };
      return;
    }
    if (current - startedAt >= totalTimeoutMs) {
      logAgentEvent({
        eventType: 'agent.error',
        errorCategory: 'chat_timeout',
        requestId,
        totalMs: current - startedAt,
      });
      yield { kind: 'failure', errorCode: 'CHAT_TIMEOUT' };
      return;
    }

    // Step 6: respect the cadence ceiling.
    await sleep(chunkIntervalMs);
  }
}
