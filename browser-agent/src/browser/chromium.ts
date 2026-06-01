/**
 * Chromium lifecycle for the browser-agent.
 *
 * Owns the single concern of launching a real, non-headless Chromium
 * (R8.2) under puppeteer-extra with the stealth plugin, against a
 * persistent user-data directory (R8.3), retrying on transient failures
 * within a bounded budget (R8.5), and wiring the underlying `Browser`
 * `disconnected` event into the caller's relaunch hook (R11.4, R11.7).
 *
 * This module has *no* knowledge of the agent FSM, ChatGPT_Pro, or the
 * relay socket. The state machine in `state/machine.ts` consumes the
 * returned `Browser` and the `onDisconnected` callback to drive the
 * `restarting` transition.
 *
 * Cross-platform (R8.10) is satisfied by delegating entirely to
 * puppeteer's launcher; we only contribute Linux-friendly args
 * (`--no-sandbox`, `--disable-setuid-sandbox`) which are no-ops on
 * Windows/macOS, plus `--disable-blink-features=AutomationControlled`
 * to support the stealth plugin.
 *
 * Implements R8.1, R8.2, R8.3, R8.5, R8.10, R11.4, R11.7.
 */

import type { Browser } from 'puppeteer';

/**
 * Launcher abstraction so tests can stub puppeteer without touching the
 * real binary. Production wiring resolves to a `puppeteer-extra` instance
 * with the stealth plugin registered exactly once per process.
 *
 * The launch input is intentionally typed as `object` (not the
 * `LaunchOptions` from `puppeteer-core`) so that the consumer of this
 * abstraction is decoupled from puppeteer's internal type changes across
 * versions.
 */
export interface Launcher {
  launch(opts: object): Promise<Browser>;
}

/**
 * Options accepted by {@link launchChromium}. Everything except
 * `userDataDir` has a sensible default. Tests inject `now`, `sleep`, and
 * `launcher` to deterministically exercise the retry loop without
 * spawning a real Chromium.
 */
export interface LaunchOptions {
  /** Absolute path to the persistent Chromium profile dir. R8.3. */
  userDataDir: string;
  /** Per-attempt timeout in ms. Default 30_000 (R8.1). */
  timeoutMs?: number;
  /** Total budget across all attempts in ms. Default 30_000. */
  totalBudgetMs?: number;
  /** Number of retry attempts after the first failure. Default 3 (R8.5). */
  maxRetries?: number;
  /** Inter-attempt delay in ms. Default 5_000 (R8.5). */
  retryDelayMs?: number;
  /** Optional callback fired when Chromium emits `disconnected` (R11.4). */
  onDisconnected?: () => void;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Sleep injection for tests. Defaults to a `setTimeout`-based promise. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional puppeteer launcher injection — defaults to `puppeteer-extra`
   * with `puppeteer-extra-plugin-stealth` enabled. Tests pass a fake to
   * avoid launching a real Chromium.
   */
  launcher?: Launcher;
}

/**
 * Cached default launcher instance — `puppeteer-extra` with the stealth
 * plugin registered. Cached so we never re-register the plugin on
 * subsequent launches (the plugin layer is process-global and a second
 * `.use()` call against the same instance would queue duplicate hooks).
 */
let cachedLauncher: Launcher | null = null;

/**
 * Resolve the production launcher: dynamically import `puppeteer-extra`,
 * register `puppeteer-extra-plugin-stealth`, and adapt the result to the
 * narrow {@link Launcher} surface this module consumes.
 *
 * Implements the puppeteer-extra + stealth wiring half of R8.1.
 */
async function defaultLauncher(): Promise<Launcher> {
  if (cachedLauncher !== null) return cachedLauncher;
  const puppeteerExtraMod: { default: { use: (p: unknown) => unknown; launch: (o: object) => Promise<Browser> } } =
    (await import('puppeteer-extra')) as unknown as {
      default: { use: (p: unknown) => unknown; launch: (o: object) => Promise<Browser> };
    };
  const stealthMod: { default: () => unknown } = (await import(
    'puppeteer-extra-plugin-stealth'
  )) as unknown as { default: () => unknown };
  const puppeteerExtra = puppeteerExtraMod.default;
  const stealth = stealthMod.default;
  puppeteerExtra.use(stealth());
  cachedLauncher = {
    launch: (opts: object): Promise<Browser> => puppeteerExtra.launch(opts),
  };
  return cachedLauncher;
}

/**
 * Default sleep — promise that resolves after `ms` milliseconds.
 * Pulled out so tests can inject a synchronous `sleep` and avoid real
 * timers.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Single structured-JSON warn line emitted to stderr on each failed
 * launch attempt. The shape is stable: `{ ts, level:'warn', msg, attempt,
 * error }` — log consumers can match on `msg === 'chromium_launch_failed'`.
 *
 * SOP S2.5 prohibits `console.log`; we go straight to `process.stderr.write`
 * to avoid pulling the logger module into a file that must work even
 * before the agent is fully booted.
 */
function logLaunchFailure(attempt: number, error: Error): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: 'warn',
    msg: 'chromium_launch_failed',
    attempt,
    error: error.message,
  });
  process.stderr.write(line + '\n');
}

/**
 * Launch Chromium with stealth, retry on failure, and wire `disconnected`
 * to the caller's hook. Returns a connected {@link Browser}. The caller
 * is responsible for `browser.close()` on shutdown.
 *
 * Algorithm (R8.5):
 *   1. for attempt in 1..(maxRetries+1):
 *      - try `launcher.launch(...)` with a 30 s per-attempt timeout
 *      - on success: wire disconnect handler, return browser
 *      - on failure: log structured error
 *      - if attempt is the last, break
 *      - if total elapsed >= totalBudgetMs, break
 *      - sleep retryDelayMs, retry
 *   2. After all retries fail, throw the last error wrapped with the
 *      attempt count, so callers can decide whether to exit non-zero
 *      (R8.5: agent exits non-zero on exhaustion).
 *
 * Implements R8.1, R8.2, R8.3, R8.5, R8.10, R11.4, R11.7.
 *
 * @param opts See {@link LaunchOptions}.
 * @returns The connected {@link Browser}.
 * @throws Error When all attempts are exhausted or the total budget is
 *   spent without a successful launch.
 */
export async function launchChromium(opts: LaunchOptions): Promise<Browser> {
  const timeoutMs: number = opts.timeoutMs ?? 30_000;
  const totalBudgetMs: number = opts.totalBudgetMs ?? 30_000;
  const maxRetries: number = opts.maxRetries ?? 3;
  const retryDelayMs: number = opts.retryDelayMs ?? 5_000;
  const now: () => number = opts.now ?? Date.now;
  const sleep: (ms: number) => Promise<void> = opts.sleep ?? defaultSleep;
  const launcher: Launcher = opts.launcher ?? (await defaultLauncher());

  // Args common to all platforms. `--no-sandbox` / `--disable-setuid-sandbox`
  // are required when running as root inside containers (e.g. CI) and are
  // ignored on Windows/macOS, so they're safe to keep on by default.
  // `--disable-blink-features=AutomationControlled` complements stealth.

  // Resolve headless mode. ChatGPT routinely serves a Cloudflare /
  // anti-automation interstitial to headless Chromium in 2026 even
  // with puppeteer-extra-plugin-stealth, so we default to NON-headless
  // visible-but-minimized off-screen mode (`--start-minimized` plus
  // a far-off `--window-position`). Power users can override:
  //   AGENT_HEADLESS=true  → run pure headless (faster, but flaky)
  //   AGENT_HEADLESS=false → visible normally (default, unobtrusive)
  //   AGENT_HEADLESS=auto  → headless when a session cookie exists,
  //                          visible on first launch
  const headlessEnv = (process.env.AGENT_HEADLESS ?? 'false').toLowerCase().trim();
  const headlessMode: boolean = (() => {
    if (headlessEnv === 'true' || headlessEnv === '1') return true;
    if (headlessEnv === 'false' || headlessEnv === '0') return false;
    if (headlessEnv !== 'auto') return false;
    // `auto`: detect a previous successful login by looking for a
    // populated Cookies SQLite. Chromium 128+ moved this from
    // `Default/Cookies` to `Default/Network/Cookies`; we check both
    // locations.
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      const path = require('node:path') as typeof import('node:path');
      const candidates = [
        path.join(opts.userDataDir, 'Default', 'Network', 'Cookies'),
        path.join(opts.userDataDir, 'Default', 'Cookies'),
      ];
      for (const cookieFile of candidates) {
        try {
          const stat = fs.statSync(cookieFile);
          if (stat.size > 4096) return true;
        } catch {
          /* try next candidate */
        }
      }
      return false;
    } catch {
      return false;
    }
  })();

  // Window visibility: when not headless, show the window on-screen
  // so the user can observe ChatGPT interactions. When headless or
  // explicitly hidden, push it off-screen and minimize.
  const wantVisible = !headlessMode;

  const args: string[] = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    ...(wantVisible
      ? [] // visible: no minimization, default window position on-screen
      : ['--start-minimized', '--window-position=4000,4000']),
  ];

  const launchOptions: Readonly<{
    headless: boolean;
    userDataDir: string;
    args: string[];
    defaultViewport: null;
    timeout: number;
    executablePath?: string;
  }> = {
    headless: headlessMode, // R8.2 — non-headless on first login, headless after
    userDataDir: opts.userDataDir, // R8.3
    args,
    defaultViewport: null,
    timeout: timeoutMs, // R8.1
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  };

  const start: number = now();
  const totalAttempts: number = Math.max(1, maxRetries + 1);
  let attempts = 0;
  let lastError: Error = new Error('no launch attempted');

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    attempts = attempt;
    try {
      const browser: Browser = await launcher.launch(launchOptions);
      // R11.4: surface the underlying Chromium disconnect to the caller's
      // hook so the FSM can transition to `restarting` and request a
      // relaunch within 30 s (R11.7).
      browser.on('disconnected', () => {
        opts.onDisconnected?.();
      });
      return browser;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      logLaunchFailure(attempt, lastError);

      // No more attempts permitted.
      if (attempt >= totalAttempts) break;

      // Budget exhausted — stop early rather than burn the inter-attempt
      // delay on a launch we know we can't afford.
      if (now() - start >= totalBudgetMs) break;

      await sleep(retryDelayMs);

      // The sleep itself may have eaten the remaining budget. Re-check so
      // we don't enter another launch attempt past the deadline.
      if (now() - start >= totalBudgetMs) break;
    }
  }

  throw new Error(
    `chromium launch failed after ${attempts} attempts: ${lastError.message}`,
  );
}
