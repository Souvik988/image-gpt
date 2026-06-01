/**
 * Property test for IP rate limiter — task 5.5.
 *
 * Uses fc.commands over Attempt(success: boolean, t: number) with
 * monotone-increasing times; reference O(n) limiter; numRuns: 200.
 *
 * **Validates: Requirements 2.6**
 */

// Feature: kiro-gpt-bridge, Property 9: an IP is locked at time t iff it had >=5 failures within a trailing 60s window at some t* <= t and t < t* + 300000

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { createRateLimiter, type RateLimiterResult } from '../src/auth/rateLimiter.js';

const WINDOW_MS = 60_000;
const THRESHOLD = 5;
const LOCKOUT_MS = 300_000;

// ─── Reference (naive O(n)) limiter ────────────────────────────────────────

interface RefState {
  failures: number[];
  lockedUntil: number | null;
}

function refTryConnect(state: RefState, t: number, success: boolean): RateLimiterResult {
  // (1) Honour active lockout
  if (state.lockedUntil !== null && state.lockedUntil > t) {
    return { allowed: false, lockedUntil: state.lockedUntil };
  }

  // Clear expired lockout
  if (state.lockedUntil !== null && state.lockedUntil <= t) {
    state.lockedUntil = null;
  }

  // (2) Prune failures outside the window
  state.failures = state.failures.filter((ts) => ts > t - WINDOW_MS);

  // (3) Success clears state
  if (success) {
    state.failures = [];
    state.lockedUntil = null;
    return { allowed: true };
  }

  // (4) Record failure and check threshold
  state.failures.push(t);
  if (state.failures.length >= THRESHOLD) {
    const lockedUntil = t + LOCKOUT_MS;
    state.lockedUntil = lockedUntil;
    return { allowed: false, lockedUntil };
  }

  return { allowed: true };
}

// ─── fc.commands model ─────────────────────────────────────────────────────

/** Attempt command: record an auth attempt at a monotone-increasing time. */
class AttemptCommand implements fc.Command<RefState, { limiter: ReturnType<typeof createRateLimiter>; clock: { t: number } }> {
  constructor(
    readonly success: boolean,
    readonly timeDelta: number,
  ) {}

  check(): boolean {
    return true;
  }

  run(
    model: RefState,
    real: { limiter: ReturnType<typeof createRateLimiter>; clock: { t: number } },
  ): void {
    real.clock.t += this.timeDelta;
    const t = real.clock.t;

    const refResult = refTryConnect(model, t, this.success);
    const realResult = real.limiter.tryConnect('192.168.1.1', this.success);

    if (refResult.allowed !== realResult.allowed) {
      throw new Error(
        `allowed mismatch at t=${t}: ref=${refResult.allowed}, real=${realResult.allowed} (success=${this.success})`,
      );
    }

    if (!refResult.allowed && !realResult.allowed) {
      if (refResult.lockedUntil !== realResult.lockedUntil) {
        throw new Error(
          `lockedUntil mismatch at t=${t}: ref=${refResult.lockedUntil}, real=${realResult.lockedUntil}`,
        );
      }
    }
  }

  toString(): string {
    return `Attempt(success=${this.success}, dt=${this.timeDelta})`;
  }
}

const attemptCommandArb: fc.Arbitrary<fc.Command<RefState, { limiter: ReturnType<typeof createRateLimiter>; clock: { t: number } }>> = fc
  .record({
    success: fc.boolean(),
    timeDelta: fc.integer({ min: 0, max: 120_000 }),
  })
  .map(({ success, timeDelta }) => new AttemptCommand(success, timeDelta));

describe('rateLimiter — Property 9: IP brute-force lockout', () => {
  it('production limiter matches reference O(n) limiter across command sequences', () => {
    fc.assert(
      fc.property(fc.commands([attemptCommandArb], { size: '+1' }), (cmds) => {
        const clock = { t: 1_000_000 };

        const limiter = createRateLimiter({
          windowMs: WINDOW_MS,
          threshold: THRESHOLD,
          lockoutMs: LOCKOUT_MS,
          now: () => clock.t,
        });

        const initialModel: RefState = { failures: [], lockedUntil: null };
        const real = { limiter, clock };

        fc.modelRun(() => ({ model: initialModel, real }), [...cmds]);

        limiter.dispose();
      }),
      { numRuns: 200 },
    );
  });
});
