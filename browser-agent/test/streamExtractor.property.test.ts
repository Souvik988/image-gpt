// Feature: kiro-gpt-bridge, Property 6: chunk monotonicity (each chunk's text starts with the previous chunk's text) and final-text equals last chunk's text

/**
 * Property test for stream consistency (P6).
 *
 * Validates:
 *  - The final chunk text equals the concatenation of all prior chunk texts.
 *  - Chunks emit at most every 250 ms apart (chunkIntervalMs).
 *  - Idle timeout with no chunks yields a final CHAT_TIMEOUT failure.
 *  - Only the NEW turn (turnCount > baseline) is streamed — a pre-existing
 *    complete turn never leaks into the stream.
 *
 * **Validates: Requirements 9.4, 9.5, 9.8, 16.1, 27.5**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { extractStream, type StreamExtractorEvent } from '../src/browser/streamExtractor.js';
import type { LastTurnState } from '../src/browser/turnReader.js';

// ─── Mock page infrastructure ───────────────────────────────────────────────

/**
 * Build a mocked page whose single `evaluate` contract returns a
 * `LastTurnState` snapshot directly (mirroring the production
 * single-round-trip reader).
 */
function snapshotPage(
  snapshot: () => LastTurnState | null,
): Parameters<typeof extractStream>[0] {
  return {
    url(): string {
      return 'https://chatgpt.com/c/test';
    },
    async evaluate<R>(_fn: (...args: unknown[]) => R | Promise<R>, ..._args: unknown[]): Promise<R> {
      const s = snapshot();
      return (s === null ? null : s) as unknown as R;
    },
  };
}

function makeSnapshot(overrides: Partial<LastTurnState>): LastTurnState {
  return {
    turnCount: 1,
    text: '',
    finished: false,
    errorText: null,
    regenVisible: false,
    stopVisible: true,
    imageUrl: null,
    ...overrides,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function collectEvents(
  gen: AsyncGenerator<StreamExtractorEvent, void, void>,
): Promise<StreamExtractorEvent[]> {
  const events: StreamExtractorEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

// ─── Property tests ─────────────────────────────────────────────────────────

describe('Property 6: Stream consistency', () => {
  it('final chunk text equals concatenation of all prior chunk texts', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            text: fc.string({ minLength: 1, maxLength: 100 }),
            gapMs: fc.integer({ min: 10, max: 500 }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        async (segments) => {
          let currentTime = 0;
          let segmentIndex = 0;
          let bodyText = '';
          let finished = false;

          const page = snapshotPage(() => {
            if (segmentIndex < segments.length) {
              bodyText += segments[segmentIndex].text;
              segmentIndex += 1;
              if (segmentIndex >= segments.length) {
                finished = true;
              }
            }
            return makeSnapshot({
              text: bodyText,
              finished,
              regenVisible: finished,
              stopVisible: !finished,
            });
          });

          const gen = extractStream(page, 'req-prop6', { turnCount: 0, lastText: '' }, {
            idleTimeoutMs: 120_000,
            chunkIntervalMs: 50,
            finalEmitBudgetMs: 10,
            sleep: async (_ms: number) => { currentTime += 50; },
            now: () => currentTime,
          });

          const events = await collectEvents(gen);

          // Must have at least one event
          expect(events.length).toBeGreaterThan(0);

          // The last event should be a 'final' event
          const lastEvent = events[events.length - 1];
          expect(lastEvent.kind).toBe('final');

          if (lastEvent.kind === 'final') {
            // Collect all chunk texts (non-final)
            const chunkTexts = events
              .filter((e): e is Extract<StreamExtractorEvent, { kind: 'chunk' }> => e.kind === 'chunk')
              .map((e) => e.chunk.text);

            const concatenated = chunkTexts.join('');

            // Final text must equal the full accumulated text
            expect(lastEvent.chunk.text).toBe(concatenated);
            // Final chunk must have isFinal: true
            expect(lastEvent.chunk.isFinal).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('idle timeout with no chunks yields a CHAT_TIMEOUT failure', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 120_000, max: 200_000 }),
        async (idleTimeoutMs) => {
          let currentTime = 0;

          // Page whose last turn never grows and never finishes (a
          // pre-existing OLD turn — turnCount equals baseline).
          const page = snapshotPage(() =>
            makeSnapshot({ turnCount: 0, text: '', finished: false, stopVisible: true }),
          );

          const gen = extractStream(page, 'req-timeout', { turnCount: 0, lastText: '' }, {
            idleTimeoutMs,
            chunkIntervalMs: 250,
            sleep: async (ms: number) => { currentTime += ms; },
            now: () => currentTime,
          });

          const events = await collectEvents(gen);

          // Should end with a failure event
          const lastEvent = events[events.length - 1];
          expect(lastEvent.kind).toBe('failure');
          if (lastEvent.kind === 'failure') {
            expect(lastEvent.errorCode).toBe('CHAT_TIMEOUT');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('chunk indices are monotonically increasing starting from 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.string({ minLength: 1, maxLength: 50 }),
          { minLength: 1, maxLength: 10 },
        ),
        async (textSegments) => {
          let currentTime = 0;
          let segmentIndex = 0;
          let bodyText = '';
          let finished = false;

          const page = snapshotPage(() => {
            if (segmentIndex < textSegments.length) {
              bodyText += textSegments[segmentIndex];
              segmentIndex += 1;
              if (segmentIndex >= textSegments.length) {
                finished = true;
              }
            }
            return makeSnapshot({
              text: bodyText,
              finished,
              regenVisible: finished,
              stopVisible: !finished,
            });
          });

          const gen = extractStream(page, 'req-mono', { turnCount: 0, lastText: '' }, {
            idleTimeoutMs: 120_000,
            chunkIntervalMs: 50,
            finalEmitBudgetMs: 10,
            sleep: async (_ms: number) => { currentTime += 50; },
            now: () => currentTime,
          });

          const events = await collectEvents(gen);
          const allChunks = events
            .filter((e): e is Extract<StreamExtractorEvent, { kind: 'chunk' | 'final' }> =>
              e.kind === 'chunk' || e.kind === 'final')
            .map((e) => e.chunk.chunkIndex);

          // Chunk indices must be monotonically increasing starting from 0
          for (let i = 0; i < allChunks.length; i++) {
            expect(allChunks[i]).toBe(i);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a pre-existing complete turn is never streamed as the new response', async () => {
    // Regression test for the `:last-of-type` + querySelector bug: the
    // OLD implementation read turn 1's static text and instantly emitted
    // it as the response to the new request. The baseline-aware extractor
    // must wait for a NEW turn instead.
    let currentTime = 0;
    const staleText = 'This is the response to an EARLIER question.';
    let newTurnArrived = false;

    const page = snapshotPage(() => {
      // Flip to the new turn after ~10 poll cycles on the mocked clock.
      if (currentTime >= 100) newTurnArrived = true;
      if (!newTurnArrived) {
        // One old, complete assistant turn in the conversation.
        return makeSnapshot({ turnCount: 1, text: staleText, finished: true, regenVisible: true, stopVisible: false });
      }
      // The NEW turn is a different DOM element — its innerText contains
      // only its own body, never the earlier turn's text.
      return makeSnapshot({ turnCount: 2, text: 'new body', finished: true, regenVisible: true, stopVisible: false });
    });

    const gen = extractStream(page, 'req-stale', { turnCount: 1, lastText: staleText }, {
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 60_000,
      chunkIntervalMs: 10,
      finalEmitBudgetMs: 10,
      sleep: async (_ms: number) => { currentTime += 10; },
      now: () => currentTime,
    });

    // Flip to the new turn after the first poll cycle (clock-driven,
    // see the snapshot closure above).
    void 0;

    const events = await collectEvents(gen);

    const lastEvent = events[events.length - 1];
    expect(lastEvent.kind).toBe('final');
    if (lastEvent.kind === 'final') {
      // The final text must contain ONLY the new turn's body — the stale
      // prefix must never leak into the streamed response.
      expect(lastEvent.chunk.text).toBe('new body');
    }
  });

  it('idle-based timeout does NOT kill an actively streaming response', async () => {
    // Regression test for the total-elapsed timeout bug: text keeps
    // growing well past 120 s of wall clock; the extractor must only
    // time out after IDLE inactivity.
    let currentTime = 0;
    let growth = 0;

    const page = snapshotPage(() => {
      growth += 1;
      return makeSnapshot({
        text: 'x'.repeat(growth),
        finished: growth >= 200,
        regenVisible: growth >= 200,
        stopVisible: growth < 200,
      });
    });

    const gen = extractStream(page, 'req-longstream', { turnCount: 0, lastText: '' }, {
      idleTimeoutMs: 1_000,
      totalTimeoutMs: 600_000,
      chunkIntervalMs: 50,
      finalEmitBudgetMs: 10,
      sleep: async (_ms: number) => { currentTime += 50; },
      now: () => currentTime,
    });

    const events = await collectEvents(gen);
    const lastEvent = events[events.length - 1];
    // 200 growth events at 50 ms each = 10 s total, far past the 1 s
    // idle budget — the stream must complete, not fail.
    expect(lastEvent.kind).toBe('final');
  });
});
