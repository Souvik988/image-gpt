/**
 * Unit tests for `stopAction.ts`.
 *
 * Covers:
 *  - Stop button present: clicked within 500 ms (R20.4)
 *  - Stop button absent: Escape keypress fallback (R20.4)
 *  - Both paths complete within 2 s (R20.4)
 *  - buildCancelledChunk produces correct final chunk shape
 *
 * _Implements: R20.4_
 */

import { describe, it, expect } from 'vitest';
import { performStopAction, buildCancelledChunk, type StopResult } from '../src/browser/stopAction.js';
import type { Page } from 'puppeteer';

// ─── Stub page infrastructure ───────────────────────────────────────────────

interface StubPageOpts {
  /** Selectors that resolve to a clickable element. */
  presentSelectors?: string[];
  /** If true, click() throws (element becomes stale). */
  clickThrows?: boolean;
  /** Track interactions. */
  interactions?: string[];
  /** If true, keyboard.press throws. */
  keyboardThrows?: boolean;
}

function createStubPage(opts: StubPageOpts = {}): Page {
  const interactions = opts.interactions ?? [];
  const presentSelectors = new Set(opts.presentSelectors ?? []);

  const page = {
    async $(selector: string): Promise<{ click: () => Promise<void> } | null> {
      interactions.push(`$:${selector}`);
      if (presentSelectors.has(selector)) {
        return {
          async click(): Promise<void> {
            if (opts.clickThrows) {
              throw new Error('Element detached');
            }
            interactions.push(`el.click:${selector}`);
          },
        };
      }
      return null;
    },
    keyboard: {
      async press(key: string): Promise<void> {
        if (opts.keyboardThrows) {
          throw new Error('Page closed');
        }
        interactions.push(`keyboard.press:${key}`);
      },
    },
  } as unknown as Page;

  return page;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('stopAction', () => {
  describe('performStopAction', () => {
    it('clicks the Stop button when present and completes within 500 ms', async () => {
      const interactions: string[] = [];
      let time = 0;
      const page = createStubPage({
        presentSelectors: ['button[data-testid="stop-button"]'],
        interactions,
      });

      const result: StopResult = await performStopAction(page, {
        now: () => time++, // each call advances by 1ms
      });

      expect(result.clicked).toBe(true);
      expect(result.durationMs).toBeLessThanOrEqual(500);
      // Verify the click actually happened
      expect(interactions.some((i) => i.startsWith('el.click:'))).toBe(true);
    });

    it('falls back to Escape when no Stop selector matches within 500 ms', async () => {
      const interactions: string[] = [];
      let time = 0;
      const page = createStubPage({
        presentSelectors: [], // no stop button
        interactions,
      });

      const result: StopResult = await performStopAction(page, {
        now: () => {
          // Simulate time advancing past the 500ms budget
          const current = time;
          time += 100; // each now() call advances 100ms
          return current;
        },
      });

      expect(result.clicked).toBe(false);
      // Escape should have been pressed
      expect(interactions).toContain('keyboard.press:Escape');
    });

    it('completes within 2 seconds even when Stop button is absent', async () => {
      let time = 0;
      const page = createStubPage({
        presentSelectors: [],
      });

      const result: StopResult = await performStopAction(page, {
        now: () => {
          const current = time;
          time += 100;
          return current;
        },
      });

      expect(result.durationMs).toBeLessThanOrEqual(2000);
    });

    it('tries next selector when click throws (element stale)', async () => {
      const interactions: string[] = [];
      let time = 0;
      // First selector present but click throws; second selector also present
      const page = {
        async $(selector: string): Promise<{ click: () => Promise<void> } | null> {
          interactions.push(`$:${selector}`);
          if (selector === 'button[data-testid="stop-button"]') {
            return {
              async click(): Promise<void> {
                throw new Error('Element detached');
              },
            };
          }
          if (selector === 'button[aria-label="Stop streaming"]') {
            return {
              async click(): Promise<void> {
                interactions.push(`el.click:${selector}`);
              },
            };
          }
          return null;
        },
        keyboard: {
          async press(key: string): Promise<void> {
            interactions.push(`keyboard.press:${key}`);
          },
        },
      } as unknown as Page;

      const result: StopResult = await performStopAction(page, {
        now: () => time++,
      });

      expect(result.clicked).toBe(true);
      expect(interactions.some((i) => i.includes('el.click:button[aria-label="Stop streaming"]'))).toBe(true);
    });

    it('handles keyboard.press throwing gracefully (page closed)', async () => {
      let time = 0;
      const page = createStubPage({
        presentSelectors: [],
        keyboardThrows: true,
      });

      // Should not throw even when Escape fails
      const result: StopResult = await performStopAction(page, {
        now: () => {
          const current = time;
          time += 100;
          return current;
        },
      });

      expect(result.clicked).toBe(false);
      // Duration should still be reported
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('buildCancelledChunk', () => {
    it('produces a final chunk with status cancelled and partial text', () => {
      const chunk = buildCancelledChunk('req-cancel-1', 'partial response text', 5);

      expect(chunk.protocolVersion).toBe(1);
      expect(chunk.requestId).toBe('req-cancel-1');
      expect(chunk.chunkIndex).toBe(5);
      expect(chunk.text).toBe('partial response text');
      expect(chunk.isFinal).toBe(true);
      expect(chunk.status).toBe('cancelled');
    });

    it('handles empty partial text', () => {
      const chunk = buildCancelledChunk('req-cancel-2', '', 0);

      expect(chunk.text).toBe('');
      expect(chunk.isFinal).toBe(true);
      expect(chunk.status).toBe('cancelled');
      expect(chunk.chunkIndex).toBe(0);
    });
  });
});
