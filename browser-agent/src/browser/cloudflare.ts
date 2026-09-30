/**
 * Cloudflare interstitial handling ("Just a moment…" / Turnstile).
 *
 * ChatGPT serves an anti-automation challenge page to fresh browser
 * launches. The challenge usually clears with a trusted click on the
 * Turnstile checkbox when the browser fingerprint is trustworthy (real
 * Chrome + stealth) — which is exactly this agent's configuration. The
 * handler locates the challenge iframe, performs a short human-like
 * mouse approach, clicks the checkbox, and polls until the title
 * changes.
 */

/** Structural subset of the puppeteer Page the handler needs. */
export interface CloudflarePage {
  title(): Promise<string>;
  $(selector: string): Promise<
    | {
        boundingBox(): Promise<{
          x: number;
          y: number;
          width: number;
          height: number;
        } | null>;
      }
    | null
  >;
  mouse: {
    move(x: number, y: number): Promise<void>;
    click(x: number, y: number): Promise<void>;
  };
}

export interface TryPassCloudflareOptions {
  /** Maximum checkbox-click attempts. Default 3. */
  maxAttempts?: number;
  /** Delay between attempts in ms. Default 25 000 — rapid retry bursts
   * read as robotic to Turnstile and cause it to re-issue challenges. */
  attemptDelayMs?: number;
  /** Sleep injection for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** True when the page title indicates a Cloudflare interstitial. */
export function isChallengeTitle(title: string): boolean {
  const t = (title ?? '').toLowerCase();
  return (
    t.includes('just a moment') ||
    t.includes('attention required') ||
    t.includes('verify you are human') ||
    t.includes('checking your browser')
  );
}

/** Current title, swallowing navigation races. */
async function safeTitle(page: CloudflarePage): Promise<string> {
  try {
    return await page.title();
  } catch {
    return '';
  }
}

/**
 * If `page` shows a Cloudflare interstitial, click the Turnstile
 * checkbox (bounded attempts) until the title clears.
 *
 * Returns the final challenge state: `true` when the page is THROUGH
 * the challenge (or never showed one), `false` when the interstitial
 * persisted past the attempt budget.
 */
export async function tryPassCloudflare(
  page: CloudflarePage,
  opts: TryPassCloudflareOptions = {},
): Promise<boolean> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const attemptDelayMs = opts.attemptDelayMs ?? 25_000;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  if (!isChallengeTitle(await safeTitle(page))) return true;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let box: { x: number; y: number; width: number; height: number } | null = null;
    try {
      const handle = await page.$('iframe[src*="challenges.cloudflare.com"]');
      if (handle !== null) {
        box = await handle.boundingBox();
      }
    } catch {
      // Page navigated mid-probe — re-check the title next loop.
    }

    if (box !== null && box.width > 0 && box.height > 0) {
      // The Turnstile checkbox sits near the left edge, vertically
      // centered. Approach it with a couple of intermediate moves so the
      // event stream looks less like a synthetic teleport-click.
      const cx = Math.round(box.x + 28);
      const cy = Math.round(box.y + box.height / 2);
      try {
        await page.mouse.move(Math.max(0, cx - 60), Math.max(0, cy - 30));
        await page.mouse.move(Math.max(0, cx - 15), Math.max(0, cy - 5));
        await page.mouse.move(cx, cy);
        await page.mouse.click(cx, cy);
      } catch {
        // Mouse events can race navigation — the next attempt re-locates.
      }
    }

    await sleep(attemptDelayMs);
    if (!isChallengeTitle(await safeTitle(page))) return true;
  }

  return !isChallengeTitle(await safeTitle(page));
}
