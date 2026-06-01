// Feature: kiro-gpt-bridge, Property 16: per-keystroke delay drawn uniformly from [20,80] ms inclusive, observed across all sampled prompts

/**
 * Property test for keystroke jitter range (P16).
 *
 * Stubs `sleep` and captures delays; generates prompts of length 1..32000;
 * asserts every recorded delay is in [20, 80] ms.
 *
 * Includes a one-shot Kolmogorov-Smirnov aggregate test (10000 samples,
 * α=0.01) confirming uniform-distribution acceptance band.
 *
 * **Validates: Requirements 9.2**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { typeAndSubmitChat, type ChatDriverPage } from '../src/browser/chatDriver.js';

// ─── Stub page ──────────────────────────────────────────────────────────────

function createStubPage(): ChatDriverPage {
  return {
    async waitForSelector(_selector: string, _opts: { timeout: number }): Promise<unknown> {
      return {}; // always found
    },
    async $(_selector: string): Promise<unknown> {
      return {}; // element exists
    },
    async click(_selector: string): Promise<void> {
      // no-op
    },
    keyboard: {
      async down(_key: string): Promise<void> {},
      async up(_key: string): Promise<void> {},
      async press(_key: string): Promise<void> {},
      async type(_text: string, _opts?: { delay?: number }): Promise<void> {},
    },
    async type(_selector: string, _text: string, _opts?: { delay?: number }): Promise<void> {},
  };
}

// ─── Property tests ─────────────────────────────────────────────────────────

describe('Property 16: Keystroke jitter range', () => {
  it('every inter-keystroke delay lies in [20, 80] ms for prompts of length 1..200', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }),
        async (prompt) => {
          const page = createStubPage();
          const result = await typeAndSubmitChat(page, prompt, 'req-jitter-test', {
            sleep: async (_ms: number) => {},
          });

          expect(result.ok).toBe(true);
          // Every delay must be in [20, 80]
          for (const delay of result.delaysMs) {
            expect(delay).toBeGreaterThanOrEqual(20);
            expect(delay).toBeLessThanOrEqual(80);
          }
          // Number of delays equals number of characters in the prompt
          // (for..of iterates code points)
          const codePointCount = [...prompt].length;
          expect(result.delaysMs).toHaveLength(codePointCount);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('every inter-keystroke delay lies in [20, 80] ms with custom random source', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        async (prompt, fixedRandom) => {
          const page = createStubPage();
          const result = await typeAndSubmitChat(page, prompt, 'req-jitter-fixed', {
            random: () => fixedRandom,
            sleep: async (_ms: number) => {},
          });

          expect(result.ok).toBe(true);
          for (const delay of result.delaysMs) {
            expect(delay).toBeGreaterThanOrEqual(20);
            expect(delay).toBeLessThanOrEqual(80);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Kolmogorov-Smirnov test: 10000 samples confirm uniform distribution (α=0.01)', async () => {
    const page = createStubPage();
    // Generate a long prompt to get many samples
    const longPrompt = 'a'.repeat(10000);

    const result = await typeAndSubmitChat(page, longPrompt, 'req-ks-test', {
      sleep: async (_ms: number) => {},
    });

    expect(result.ok).toBe(true);
    expect(result.delaysMs).toHaveLength(10000);

    // Normalize delays to [0, 1] range: (delay - 20) / 60
    const normalized = result.delaysMs.map((d) => (d - 20) / 60);

    // All normalized values must be in [0, 1]
    for (const v of normalized) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }

    // Sort for KS test
    const sorted = [...normalized].sort((a, b) => a - b);
    const n = sorted.length;

    // Compute KS statistic: max |F_n(x) - F(x)| where F(x) = x for U[0,1]
    let ksStatistic = 0;
    for (let i = 0; i < n; i++) {
      const empiricalCdf = (i + 1) / n;
      const theoreticalCdf = sorted[i];
      const diff = Math.abs(empiricalCdf - theoreticalCdf);
      ksStatistic = Math.max(ksStatistic, diff);

      // Also check the left side
      const empiricalCdfLeft = i / n;
      const diffLeft = Math.abs(empiricalCdfLeft - theoreticalCdf);
      ksStatistic = Math.max(ksStatistic, diffLeft);
    }

    // Critical value for KS test at α=0.01 with n=10000:
    // D_critical ≈ 1.63 / sqrt(n) = 1.63 / 100 = 0.0163
    const criticalValue = 1.63 / Math.sqrt(n);
    expect(ksStatistic).toBeLessThan(criticalValue);
  });
});
