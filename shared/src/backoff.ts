/**
 * Exponential backoff schedule shared by the browser agent (R11.1) and the
 * KIRO extension (R21.1) when scheduling reconnection attempts to the relay.
 *
 * The contract is intentionally pure and synchronous so it can be tested
 * deterministically by Property 8 in `shared/test/backoff.property.test.ts`,
 * which asserts both the closed-form equality
 *
 *     exponentialBackoff(n) === min(1000 * 2^(n - 1), 30_000)
 *
 * and that the resulting sequence is non-decreasing in `n`.
 */

/**
 * Compute the delay (in milliseconds) before the `attempt`-th reconnect try.
 *
 * Returns `Math.min(base * Math.pow(2, attempt - 1), cap)` for `attempt >= 1`.
 * The schedule starts at `base` (default 1000 ms) and doubles each attempt up
 * to `cap` (default 30_000 ms). With the defaults this produces the sequence
 * `1000, 2000, 4000, 8000, 16000, 30000, 30000, ...` — saturating at `cap`
 * from attempt 6 onward, which satisfies R11.1 / R21.1.
 *
 * Validated by Property 8 (backoff schedule).
 *
 * Overflow safety: even when `attempt` is large enough that
 * `base * 2^(attempt - 1)` would exceed `Number.MAX_SAFE_INTEGER` (or even
 * become `Infinity`), `Math.min` against the finite `cap` clamps the result
 * to `cap` long before any floating-point representation issue can leak out.
 *
 * @param attempt 1-based attempt number (1 -> base, 2 -> base*2, ...).
 * @param base    Initial delay in milliseconds. Default 1000.
 * @param cap     Maximum delay in milliseconds. Default 30_000.
 * @returns       The clamped delay in milliseconds.
 * @throws {RangeError} If `attempt < 1`, `base <= 0`, `cap <= 0`, `cap < base`,
 *                     or any argument is non-finite (NaN / +/-Infinity).
 */
export function exponentialBackoff(
  attempt: number,
  base: number = 1000,
  cap: number = 30_000,
): number {
  if (!Number.isFinite(attempt) || attempt < 1) {
    throw new RangeError(
      `exponentialBackoff: attempt must be >= 1, got ${attempt}`,
    );
  }
  if (!Number.isFinite(base) || base <= 0) {
    throw new RangeError(
      `exponentialBackoff: base must be > 0, got ${base}`,
    );
  }
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new RangeError(
      `exponentialBackoff: cap must be > 0, got ${cap}`,
    );
  }
  if (cap < base) {
    throw new RangeError(
      `exponentialBackoff: cap must be >= base, got cap=${cap}, base=${base}`,
    );
  }

  return Math.min(base * Math.pow(2, attempt - 1), cap);
}
