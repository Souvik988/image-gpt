// Feature: kiro-gpt-bridge, Property 8: backoff(n) === min(1000 * 2^(n-1), 30000) and is non-decreasing in n
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { exponentialBackoff } from '../src/backoff.js';

/**
 * Property 8 — reconnect backoff schedule. Validates Requirements 11.1
 * (browser-agent reconnect schedule) and 21.1 (kiro-extension reconnect
 * schedule). Both components share `shared/src/backoff.ts`, so locking
 * the closed-form here is sufficient to cover both requirements.
 *
 * The closed form is `min(1000 * 2^(n-1), 30000)` for n ≥ 1, with the
 * cap (30 000 ms) reached at n = 6 and held forever after. Two assertions
 * on every example:
 *   (a) exact equality with the closed form computed independently in
 *       this file (no shared helper — that would defeat the property),
 *   (b) the sequence is non-decreasing as n grows.
 */
describe('Property 8: exponential backoff schedule', () => {
  it('exponentialBackoff(n) === min(1000 * 2^(n-1), 30000) and is non-decreasing for n in [1, 30]', () => {
    const BASE = 1000;
    const CAP = 30_000;

    const prop = fc.property(
      // Range matches the task spec exactly: n in [1, 30].
      fc.integer({ min: 1, max: 30 }),
      (n) => {
        // Reference closed-form: computed inline so the property doesn't
        // accidentally validate the implementation against itself.
        const expected = Math.min(BASE * Math.pow(2, n - 1), CAP);

        const actual = exponentialBackoff(n);
        expect(actual).toBe(expected);

        // Monotonicity: every step n → n+1 must not decrease. Held over
        // the full domain, this is equivalent to "the schedule is
        // non-decreasing in n" — the property's second clause.
        if (n < 30) {
          const next = exponentialBackoff(n + 1);
          expect(next).toBeGreaterThanOrEqual(actual);
        }
      },
    );

    fc.assert(prop, { numRuns: 100 });
  });
});
