/**
 * Per-IP, in-memory authentication rate limiter implementing R2.6:
 *
 * > IF the Relay_Server records 5 OR MORE failed authentication attempts
 * > from the same source IP address WITHIN A 60-SECOND WINDOW, THEN THE
 * > Relay_Server SHALL reject further connection attempts from that IP
 * > for 300 seconds and SHALL log the lockout with the IP address,
 * > attempt count, and timestamp.
 *
 * The attempt that pushes the trailing-window failure count to >= 5 is
 * itself rejected (it carries the lockout into being). A successful
 * authentication clears all failure history and any active lockout for
 * that IP — the caller has proven knowledge of the secret.
 */

/**
 * Per-IP record kept by the rate limiter.
 *
 * @internal — not exported because it is an implementation detail of the
 * limiter; tests that need to inspect state should drive the public
 * `tryConnect` API instead.
 */
interface IpRecord {
  /** Failure timestamps (ms) within the trailing 60-s window. Pruned in-place on each touch. */
  failures: number[];
  /** When set and > now, all attempts are rejected without checking the secret. */
  lockedUntil: number | null;
}

/** Tunable parameters for {@link createRateLimiter}. All fields are optional. */
export interface RateLimiterOptions {
  /** Window length in ms over which failures accumulate. Default 60_000. */
  windowMs?: number;
  /** Failure count that triggers a lockout. Default 5. */
  threshold?: number;
  /** Lockout duration in ms once threshold is reached. Default 300_000. */
  lockoutMs?: number;
  /** Clock for testability. Defaults to `() => Date.now()`. */
  now?: () => number;
}

/** Outcome of a single {@link RateLimiter.tryConnect} call. */
export interface RateLimiterResult {
  /** True iff this attempt may proceed to secret comparison. */
  allowed: boolean;
  /** When `allowed` is false, the unix-ms timestamp at which the lockout expires. */
  lockedUntil?: number;
}

/** Public surface of the rate limiter. Implements R2.6. */
export interface RateLimiter {
  /**
   * Record an authentication attempt for `ip` and return whether it is
   * allowed. The `success` flag indicates whether the secret matched.
   *
   * Behavior:
   *  1. If the IP is currently locked (`lockedUntil > now`), return
   *     `{ allowed: false, lockedUntil }` WITHOUT touching the failure
   *     window.
   *  2. Otherwise prune failures older than `windowMs` from the trailing
   *     window.
   *  3. If `success` is true, clear the failure window and the lockout
   *     and return `{ allowed: true }`.
   *  4. If `success` is false, append `now()` to the failure window. If
   *     the window now contains `>= threshold` entries, set `lockedUntil
   *     = now + lockoutMs` and return `{ allowed: false, lockedUntil }`.
   *     Otherwise return `{ allowed: true }` (the attempt was processed
   *     but failed; the lockout is pre-emptive at threshold).
   */
  tryConnect(ip: string, success: boolean): RateLimiterResult;

  /** Periodic prune; removes entries with empty failures and no active lockout. */
  prune(): void;

  /** Stop the periodic-prune timer. Idempotent. */
  dispose(): void;
}

/**
 * Construct a fresh rate limiter. The returned limiter owns a periodic
 * prune timer (interval = `windowMs`) which is `unref()`ed so it does not
 * keep the Node event loop alive on its own. Callers MUST call
 * {@link RateLimiter.dispose} during shutdown to release the timer.
 *
 * Implements R2.6.
 */
export function createRateLimiter(opts: RateLimiterOptions = {}): RateLimiter {
  const windowMs = opts.windowMs ?? 60_000;
  const threshold = opts.threshold ?? 5;
  const lockoutMs = opts.lockoutMs ?? 300_000;
  const now = opts.now ?? ((): number => Date.now());

  const records = new Map<string, IpRecord>();

  const getOrCreate = (ip: string): IpRecord => {
    let rec = records.get(ip);
    if (rec === undefined) {
      rec = { failures: [], lockedUntil: null };
      records.set(ip, rec);
    }
    return rec;
  };

  const pruneFailures = (rec: IpRecord, t: number): void => {
    const cutoff = t - windowMs;
    // Failures are appended in monotone order under a single clock, so the
    // array is already sorted. Drop the leading prefix that falls outside
    // the window.
    let drop = 0;
    while (drop < rec.failures.length) {
      const ts = rec.failures[drop];
      if (ts === undefined || ts > cutoff) break;
      drop++;
    }
    if (drop > 0) rec.failures.splice(0, drop);
  };

  const tryConnect = (ip: string, success: boolean): RateLimiterResult => {
    const t = now();
    const rec = getOrCreate(ip);

    // (1) Honour an active lockout WITHOUT touching the failure window.
    if (rec.lockedUntil !== null && rec.lockedUntil > t) {
      return { allowed: false, lockedUntil: rec.lockedUntil };
    }

    // The lockout has expired; clear it so the IP gets a fresh window.
    if (rec.lockedUntil !== null && rec.lockedUntil <= t) {
      rec.lockedUntil = null;
    }

    // (2) Prune the trailing window before evaluating the current attempt.
    pruneFailures(rec, t);

    // (3) Successful auth clears state.
    if (success) {
      rec.failures.length = 0;
      rec.lockedUntil = null;
      return { allowed: true };
    }

    // (4) Record the failure and check whether it triggers a lockout.
    rec.failures.push(t);
    if (rec.failures.length >= threshold) {
      const lockedUntil = t + lockoutMs;
      rec.lockedUntil = lockedUntil;
      return { allowed: false, lockedUntil };
    }

    return { allowed: true };
  };

  const prune = (): void => {
    const t = now();
    for (const [ip, rec] of records) {
      pruneFailures(rec, t);
      const lockedActive = rec.lockedUntil !== null && rec.lockedUntil > t;
      if (rec.failures.length === 0 && !lockedActive) {
        records.delete(ip);
      } else if (rec.lockedUntil !== null && !lockedActive) {
        // Lockout has expired but failures or other state remain — clear
        // the stale lockout marker so the next visitor takes the fast path.
        rec.lockedUntil = null;
      }
    }
  };

  let timer: NodeJS.Timeout | null = setInterval(prune, windowMs);
  // Don't keep the event loop alive solely for this housekeeping task.
  if (typeof timer.unref === 'function') timer.unref();

  const dispose = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { tryConnect, prune, dispose };
}
