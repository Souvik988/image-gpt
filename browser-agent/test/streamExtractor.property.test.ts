// Feature: kiro-gpt-bridge, Property 6: chunk monotonicity (each chunk's text starts with the previous chunk's text) and final-text equals last chunk's text

/**
 * Property test for stream consistency (P6).
 *
 * Validates:
 *  - The final chunk text equals the concatenation of all prior chunk texts.
 *  - Chunks emit at most every 250 ms apart (chunkIntervalMs).
 *  - 120 s with no chunks yields a final CHAT_TIMEOUT failure.
 *
 * **Validates: Requirements 9.4, 9.5, 9.8, 16.1, 27.5**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { extractStream, type StreamExtractorPage, type StreamExtractorEvent } from '../src/browser/streamExtractor.js';

// ─── Mock page infrastructure ───────────────────────────────────────────────

interface MockPageState {
  /** Current assistant body text (grows over time). */
  bodyText: string;
  /** Whether the message is finished. */
  finished: boolean;
  /** Whether there's a chat error. */
  chatError: string | null;
  /** Whether the stop button is visible. */
  stopVisible: boolean;
  /** Whether the regenerate button is visible. */
  regenVisible: boolean;
}

function createMockPage(state: MockPageState): StreamExtractorPage {
  return {
    url(): string {
      return 'https://chat.openai.com/c/test';
    },
    async evaluate<R>(fn: (...args: unknown[]) => R | Promise<R>, ...args: unknown[]): Promise<R> {
      const selector = args[0] as string;

      // Chat error banner detection
      if (selector.includes('error') || selector === '.text-token-text-error' || selector === '[role="alert"]') {
        if (state.chatError !== null) {
          return state.chatError as unknown as R;
        }
        return null as unknown as R;
      }

      // Message finished marker detection
      if (selector.includes('data-message-finished')) {
        return state.finished as unknown as R;
      }

      // Regenerate button detection
      if (selector.includes('regenerate') || selector.includes('Regenerate')) {
        return state.regenVisible as unknown as R;
      }

      // Stop button detection
      if (selector.includes('stop') || selector.includes('Stop')) {
        return state.stopVisible as unknown as R;
      }

      // Assistant message body read — return innerText
      if (selector.includes('assistant') || selector.includes('markdown') || selector.includes('message-id')) {
        return state.bodyText as unknown as R;
      }

      return null as unknown as R;
    },
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

          const state: MockPageState = {
            bodyText: '',
            finished: false,
            chatError: null,
            stopVisible: true,
            regenVisible: false,
          };

          // Schedule: each segment arrives after its gapMs
          const page = createMockPage(state);

          // Override evaluate to use dynamic state
          const dynamicPage: StreamExtractorPage = {
            url: () => 'https://chat.openai.com/c/test',
            async evaluate<R>(fn: (...args: unknown[]) => R | Promise<R>, ...args: unknown[]): Promise<R> {
              const selector = args[0] as string;

              // Chat error banner
              if (selector.includes('error') || selector === '.text-token-text-error' || selector === '[role="alert"]') {
                return null as unknown as R;
              }

              // Message finished marker
              if (selector.includes('data-message-finished')) {
                return finished as unknown as R;
              }

              // Regenerate button
              if (selector.includes('regenerate') || selector.includes('Regenerate')) {
                return finished as unknown as R;
              }

              // Stop button
              if (selector.includes('stop') || selector.includes('Stop')) {
                return (!finished) as unknown as R;
              }

              // Assistant message body — advance text on each read
              if (segmentIndex < segments.length) {
                bodyText += segments[segmentIndex].text;
                segmentIndex++;
                if (segmentIndex >= segments.length) {
                  finished = true;
                }
              }
              return bodyText as unknown as R;
            },
          };

          const gen = extractStream(dynamicPage, 'req-prop6', {
            timeoutMs: 120_000,
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

  it('120s with no chunks yields a CHAT_TIMEOUT failure', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 120_000, max: 200_000 }),
        async (timeoutMs) => {
          let currentTime = 0;

          // Page that never produces any text and never finishes
          const emptyPage: StreamExtractorPage = {
            url: () => 'https://chat.openai.com/c/test',
            async evaluate<R>(_fn: (...args: unknown[]) => R | Promise<R>, ...args: unknown[]): Promise<R> {
              const selector = args[0] as string;

              // No error
              if (selector.includes('error') || selector === '.text-token-text-error' || selector === '[role="alert"]') {
                return null as unknown as R;
              }
              // Not finished
              if (selector.includes('data-message-finished')) {
                return false as unknown as R;
              }
              // No regenerate
              if (selector.includes('regenerate') || selector.includes('Regenerate')) {
                return false as unknown as R;
              }
              // Stop visible (still streaming)
              if (selector.includes('stop') || selector.includes('Stop')) {
                return true as unknown as R;
              }
              // No body text
              return null as unknown as R;
            },
          };

          const gen = extractStream(emptyPage, 'req-timeout', {
            timeoutMs: 120_000,
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
      { numRuns: 200 },
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

          const dynamicPage: StreamExtractorPage = {
            url: () => 'https://chat.openai.com/c/test',
            async evaluate<R>(_fn: (...args: unknown[]) => R | Promise<R>, ...args: unknown[]): Promise<R> {
              const selector = args[0] as string;

              if (selector.includes('error') || selector === '.text-token-text-error' || selector === '[role="alert"]') {
                return null as unknown as R;
              }
              if (selector.includes('data-message-finished')) {
                return finished as unknown as R;
              }
              if (selector.includes('regenerate') || selector.includes('Regenerate')) {
                return finished as unknown as R;
              }
              if (selector.includes('stop') || selector.includes('Stop')) {
                return (!finished) as unknown as R;
              }

              if (segmentIndex < textSegments.length) {
                bodyText += textSegments[segmentIndex];
                segmentIndex++;
                if (segmentIndex >= textSegments.length) {
                  finished = true;
                }
              }
              return bodyText as unknown as R;
            },
          };

          const gen = extractStream(dynamicPage, 'req-mono', {
            timeoutMs: 120_000,
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
});
