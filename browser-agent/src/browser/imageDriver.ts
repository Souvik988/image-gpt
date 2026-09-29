/**
 * Image-driver helpers for the Browser Agent.
 *
 * Drives ChatGPT through a DALL-E / GPT-Image-1 round-trip and returns
 * the result as a base64-encoded payload that fits the closed-enum
 * `mediaType` field on the wire (`image/png`, `image/jpeg`, `image/webp`,
 * `image/gif`).
 *
 * Implements R10.1 (image-prompt path entry), R10.2 (locate generated
 * image), R10.3 (extract bytes and base64 encode), R10.4 (final
 * response shape `{ mediaType, base64 }`), R10.5 (deadline →
 * `IMAGE_TIMEOUT`), R10.6 (refusal text → `CONTENT_POLICY`), R10.7
 * (prompt validation up-front; never touch the page on invalid input),
 * R10.8 (page unreachable/load failure → `CHATGPT_UNAVAILABLE`).
 *
 * Detection strategy
 * ------------------
 * The driver runs three detectors in parallel and resolves on the
 * first to fire:
 *
 *  1. **Network interception (primary).** A `page.on('response')`
 *     handler installed for the duration of the call grabs the bytes
 *     of every qualifying `image/*` response delivered after prompt
 *     submission. This bypasses the DOM entirely and is robust against
 *     portal-rendered image elements and opaque `<canvas>` previews.
 *  2. **In-page MutationObserver (fallback).** Watches `<img>` additions
 *     anywhere in the document; when an image with a qualifying `src`
 *     and dimensions ≥ 256 px appears, the driver fetches its bytes via
 *     `page.evaluate(fetch)` so the request inherits page cookies.
 *  3. **Periodic last-turn scan (safety net).** The last-turn reader
 *     also reports a qualifying image inside the most-recent assistant
 *     turn.
 *
 * Adaptive stabilization
 * ---------------------
 * The original implementation waited a FIXED 55 seconds after the first
 * captured image before returning — even when the image had fully
 * arrived in 6 seconds, adding ~49 s of dead latency to every single
 * generation. The replacement is a quiet-window: after each larger
 * capture the driver waits `stabilizationQuietMs` (default 2500 ms) for
 * a higher-quality replacement; the moment the quiet window elapses with
 * no improvement, the best capture is returned. Progressive-preview
 * pipelines (small preview first, full asset a few seconds later) are
 * still handled — the full asset resets the quiet clock when it lands.
 *
 * @packageDocumentation
 */

import { SEL } from './selectors.js';
import { typeAndSubmitChat, type ChatDriverPage } from './chatDriver.js';
import { readLastTurnState } from './turnReader.js';
import { logAgentEvent } from '../log/logger.js';
import type { ErrorCode, RequestId } from '@kiro-gpt-bridge/shared';

/**
 * Directive prefix prepended to the user prompt before submission.
 * ChatGPT routes image-intent prompts to its image tool. Implements
 * R10.1.
 */
const DALLE_PREFIX = 'Generate an image: ';

/** Maximum prompt length accepted by the image path. R10.7. */
const MAX_PROMPT_LEN = 4000;

/**
 * Soft lower-bound retained for the relaxed DOM-fallback path.
 *
 * @internal
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- documentation marker
const MIN_NETWORK_IMAGE_BYTES = 50_000;

/**
 * Hard upper bound on accepted image bytes. Mirrors the
 * `MAX_BASE64_BYTES` cap enforced by the wire schema (R26.1) — anything
 * larger than this would be rejected by the relay anyway, so we drop
 * it at the source rather than wasting CPU on a base64 round-trip.
 */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * Substrings that disqualify a URL from being treated as the
 * generated image. The check is case-insensitive.
 */
const URL_DENYLIST = [
  '/avatar',
  '/avatars/',
  '/profile',
  '/profile-pic',
  '/icon',
  '/icons/',
  '/logo',
  '/sprite',
  '/placeholder',
  '/og-image',
  '/favicon',
  '/static/', // ChatGPT's bundled UI sprites live under /static/
  '_next/image', // Next.js image optimisation pipeline
];

/**
 * Minimum byte size for a network image response to count as the
 * generated output. Generated images are typically 100 KB – 5 MB; UI
 * sprites and inline icons are virtually always under 80 KB.
 */
const MIN_NETWORK_IMAGE_BYTES_STRICT = 100_000;

/**
 * Minimum pixel dimension required for a captured PNG to count as the
 * generated output on the network path. 700 admits every generated
 * image we have observed while rejecting every plausible UI sprite
 * (avatars/icons cap at ~256 px even when resvg-rendered).
 */
const MIN_GENERATED_PIXEL_DIM = 700;

/**
 * URL substrings that mark a response as a known generated-image
 * delivery channel. Observed in production:
 *
 *   - `chatgpt.com/backend-api/estuary/content?id=file_...` — the
 *     user-content delivery endpoint.
 *   - `files.oaiusercontent.com/...` — OpenAI's CDN.
 *   - `oaidalleapiprodscus.blob.core.windows.net/...` — Azure blob
 *     fallback for older DALL-E 3 deliveries.
 */
const URL_ALLOWLIST = [
  '/backend-api/estuary/content',
  '/backend-api/files/',
  'files.oaiusercontent.com',
  'oaidalleapiprodscus.blob.core.windows.net',
];

/**
 * Minimum width/height in CSS pixels for a DOM-discovered `<img>` to
 * count as the generated image on the DOM-only fallback paths.
 */
const MIN_IMAGE_DIM_PX = 1024;

/**
 * Default poll interval used when the in-page MutationObserver has
 * already populated `window.__kiroImage`.
 */
const DEFAULT_POLL_INTERVAL_MS = 300;

/**
 * Default quiet-window for adaptive stabilization. After each larger
 * capture, wait this long for a higher-quality replacement before
 * returning the best image.
 */
const DEFAULT_STABILIZATION_QUIET_MS = 2_500;

/** Default deadline for image generation. R10.5 (≥ 180 s). */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Per-call tuning knobs and dependency injection points for
 * {@link generateImage}.
 */
export interface ImageDriverOptions {
  /** Total deadline for image generation in ms. Default 600 000. */
  timeoutMs?: number;
  /** Poll interval in ms for fallback DOM checks. Default 300. */
  pollIntervalMs?: number;
  /**
   * Quiet-window in ms for adaptive stabilization. Default 2500. Set
   * `0` to return the first qualifying capture immediately.
   */
  stabilizationQuietMs?: number;
  /**
   * Assistant-turn count captured BEFORE the prompt was submitted.
   * Refusal text in turns at or below this index belongs to previous
   * requests and is ignored. When omitted, any last-turn refusal is
   * treated as this request's.
   */
  baselineTurnCount?: number;
  /** Sleep injection for tests. Default `setTimeout`-based. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock injection for tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * Closed-enum image MIME types accepted by the wire schema.
 */
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** Successful outcome of {@link generateImage}. R10.4. */
export interface ImageDriverSuccess {
  /** Discriminator. */
  ok: true;
  /** Wire-compatible image MIME type. */
  mediaType: ImageMime;
  /** Standard base64-encoded image bytes. */
  base64: string;
}

/** Failure outcome of {@link generateImage}. */
export interface ImageDriverFailure {
  /** Discriminator. */
  ok: false;
  /** Closed-enum failure code from the wire taxonomy. */
  errorCode: ErrorCode;
  /** Diagnostic supplement; never user-facing copy. */
  message?: string;
}

/** Discriminated-union result of {@link generateImage}. */
export type ImageDriverResult = ImageDriverSuccess | ImageDriverFailure;

/**
 * Minimal structural description of a puppeteer `HTTPResponse` used by
 * the network-interception path.
 */
export interface ImageDriverResponse {
  /** Final URL of the response (after redirects). */
  url(): string;
  /** Whether the response carried a 2xx status. */
  ok(): boolean;
  /** Lower-case HTTP header map. */
  headers(): Record<string, string>;
  /** Read the response body as raw bytes. */
  buffer(): Promise<Uint8Array>;
}

/**
 * Subset of puppeteer's `Page` surface used by {@link generateImage}.
 *
 * Extends {@link ChatDriverPage} with the `evaluate` / `url` methods
 * needed for image extraction and reachability probing, plus optional
 * `on` / `off` hooks for network response interception.
 */
export interface ImageDriverPage extends ChatDriverPage {
  /**
   * Run `fn` inside the page context with the given serialisable args
   * and return the awaited result. Mirrors `Page.evaluate`.
   */
  evaluate<R>(
    fn: (...args: unknown[]) => R | Promise<R>,
    ...args: unknown[]
  ): Promise<R>;
  /** Current URL of the page. `''` or `'about:blank'` when not loaded. */
  url(): string;
  /** Optional navigation hook. */
  goto?(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  /** Optional event subscription — used for network response interception. */
  on?(
    event: 'response',
    handler: (resp: ImageDriverResponse) => void,
  ): unknown;
  /** Optional event un-subscription — paired with `on`. */
  off?(
    event: 'response',
    handler: (resp: ImageDriverResponse) => void,
  ): unknown;
}

/**
 * Submit an image-generation prompt to ChatGPT and return the
 * generated image as a base64-encoded payload, or a failure with a
 * closed-enum {@link ErrorCode}. Implements R10.1 through R10.8.
 */
export async function generateImage(
  page: ImageDriverPage,
  prompt: string,
  requestId: RequestId,
  opts: ImageDriverOptions = {},
): Promise<ImageDriverResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const quietMs = opts.stabilizationQuietMs ?? DEFAULT_STABILIZATION_QUIET_MS;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;

  // Step 1: validate prompt up-front (R10.7).
  const trimmed = prompt.trim();
  if (trimmed.length === 0 || prompt.length > MAX_PROMPT_LEN) {
    logAgentEvent({
      eventType: 'agent.error',
      errorCategory: 'invalid_prompt',
      requestId,
    });
    return { ok: false, errorCode: 'INVALID_PROMPT' };
  }

  // Step 2: page must be reachable (R10.8).
  let currentUrl: string;
  try {
    currentUrl = page.url();
  } catch (e) {
    logAgentEvent({
      eventType: 'agent.error',
      errorCategory: 'chatgpt_unavailable',
      requestId,
      error: String(e),
    });
    return { ok: false, errorCode: 'CHATGPT_UNAVAILABLE', message: String(e) };
  }
  if (currentUrl === '' || currentUrl === 'about:blank') {
    logAgentEvent({
      eventType: 'agent.error',
      errorCategory: 'chatgpt_unavailable',
      requestId,
      url: currentUrl,
    });
    return {
      ok: false,
      errorCode: 'CHATGPT_UNAVAILABLE',
      message: 'page not loaded',
    };
  }

  // Step 3: install the network interceptor BEFORE submission so it
  // captures responses that arrive milliseconds after submit.
  const networkCapture = installNetworkInterceptor(page, requestId);
  let recoveryAttempts = 0;
  const fullPrompt = DALLE_PREFIX + prompt;

  try {
    // Step 4: submit the prompt with the image directive prefix.
    logAgentEvent({
      eventType: 'agent.image_submit',
      requestId,
      promptLength: prompt.length,
    });
    const submission = await typeAndSubmitChat(
      page,
      fullPrompt,
      requestId,
      { sleep },
    );
    if (!submission.ok) {
      return {
        ok: false,
        errorCode: submission.errorCode ?? 'CHATGPT_UNAVAILABLE',
        message: submission.message,
      };
    }

    // Step 5: install the in-page MutationObserver as fallback. Errors
    // here are non-fatal; the per-tick last-turn scan still works.
    await installImageObserver(page, MIN_IMAGE_DIM_PX);

    // Step 6: single poll loop — drain network captures, watch the
    // quiet window, check refusal text, fall back to DOM sources.
    const startedAt = now();
    let bestNetHit: { mediaType: ImageMime; base64: string; byteLength: number } | null = null;
    let lastImprovementAt: number | null = null;

    while (now() - startedAt < timeoutMs) {
      // Drain all available network captures, keeping the largest.
      let netHit = networkCapture.consume();
      while (netHit !== null) {
        if (bestNetHit === null || netHit.byteLength > bestNetHit.byteLength) {
          bestNetHit = netHit;
          lastImprovementAt = now();
          logAgentEvent({
            eventType: 'agent.image_captured',
            requestId,
            source: 'network',
            bytes: netHit.byteLength,
            note: 'candidate (stabilizing)',
          });
        }
        netHit = networkCapture.consume();
      }

      // Quiet window elapsed with no larger replacement → return best.
      if (
        bestNetHit !== null &&
        lastImprovementAt !== null &&
        now() - lastImprovementAt >= quietMs
      ) {
        logAgentEvent({
          eventType: 'agent.image_captured',
          requestId,
          source: 'network',
          bytes: bestNetHit.byteLength,
          note: 'final (stabilized)',
        });
        return { ok: true, mediaType: bestNetHit.mediaType, base64: bestNetHit.base64 };
      }

      await sleep(pollIntervalMs);

      // Refusal detection — scoped to turns that appeared after the
      // pre-submit baseline so old refusals cannot poison this request.
      const state = await readLastTurnState(page);
      if (
        state !== null &&
        state.errorText !== null &&
        (opts.baselineTurnCount === undefined ||
          state.turnCount > opts.baselineTurnCount)
      ) {
        logAgentEvent({
          eventType: 'agent.error',
          errorCategory: 'content_policy',
          requestId,
        });
        return { ok: false, errorCode: 'CONTENT_POLICY', message: state.errorText };
      }

      // Failure recovery (self-healing): ChatGPT sometimes fails
      // mid-generation and renders an "Image generation failed" card
      // with a "Try again" button. Click it when present; otherwise
      // re-submit the prompt from scratch. Bounded — after
      // MAX_IMAGE_RECOVERY_ATTEMPTS the request fails instead of
      // spinning until the deadline.
      const probe = await probeImageFailure(page);
      if (probe !== null && probe.failed) {
        if (recoveryAttempts >= MAX_IMAGE_RECOVERY_ATTEMPTS) {
          logAgentEvent({
            eventType: 'agent.error',
            errorCategory: 'image_recovery_exhausted',
            requestId,
            attempts: recoveryAttempts,
          });
          return {
            ok: false,
            errorCode: 'CHATGPT_ERROR',
            message: 'image generation failed after ' + recoveryAttempts + ' recovery attempts',
          };
        }
        recoveryAttempts += 1;
        let recovered = false;
        let strategy: 'retry_button' | 'resubmit' = 'resubmit';
        if (probe.canRetry) {
          strategy = 'retry_button';
          recovered = await clickRetryButton(page);
        }
        if (!recovered) {
          const resubmitted = await typeAndSubmitChat(page, fullPrompt, requestId, { sleep });
          recovered = resubmitted.ok;
        }
        logAgentEvent({
          eventType: 'agent.image_recovery',
          requestId,
          attempt: recoveryAttempts,
          strategy,
          ok: recovered,
        });
        if (recovered) {
          // New attempt: restart the stabilization clock so the quiet
          // window measures freshness of the NEXT capture.
          lastImprovementAt = null;
          continue;
        }
      }

      // DOM fallback — only used if no network candidate is available.
      // If we already have a network hit in stabilization, skip DOM
      // scanning to avoid returning a lower-quality DOM-fetched version.
      if (bestNetHit !== null) continue;

      const observed = await readObserverResult(page);
      const domSrc = state?.imageUrl ?? observed?.src ?? (await scanForImage(page, MIN_IMAGE_DIM_PX))?.src ?? null;
      if (domSrc === null) continue;

      const fetched = await fetchAndEncode(page, domSrc);
      if (fetched === null) {
        await clearObserverResult(page);
        continue;
      }
      const mediaType = normalizeMime(fetched.mime);
      if (mediaType === null) {
        await clearObserverResult(page);
        continue;
      }
      logAgentEvent({
        eventType: 'agent.image_captured',
        requestId,
        source: 'dom',
        bytes: Math.floor((fetched.base64.length * 3) / 4),
      });
      return { ok: true, mediaType, base64: fetched.base64 };
    }

    // If we captured at least one network image but the quiet window
    // never completed before the deadline, return the best candidate
    // we have rather than failing.
    if (bestNetHit !== null) {
      logAgentEvent({
        eventType: 'agent.image_captured',
        requestId,
        source: 'network',
        bytes: bestNetHit.byteLength,
        note: 'final (timeout during stabilization)',
      });
      return { ok: true, mediaType: bestNetHit.mediaType, base64: bestNetHit.base64 };
    }

    logAgentEvent({
      eventType: 'agent.error',
      errorCategory: 'image_timeout',
      requestId,
    });
    return {
      ok: false,
      errorCode: 'IMAGE_TIMEOUT',
      message: `no image within ${timeoutMs}ms`,
    };
  } finally {
    networkCapture.dispose();
  }
}

// ─── Failure recovery (self-healing) ────────────────────────────────────────

/**
 * Text markers ChatGPT renders when an image generation fails
 * ("Image generation failed" card with a Try again button).
 */
const IMAGE_FAILURE_MARKERS = [
  'image generation failed',
  'cannot generate image',
  'unable to generate the image',
  "couldn't generate the image",
  'something went wrong while generating',
] as const;

/**
 * Bounded recovery attempts per image request. Each attempt either
 * clicks ChatGPT's "Try again" button or, when no button is present,
 * re-submits the prompt from scratch.
 */
const MAX_IMAGE_RECOVERY_ATTEMPTS = 2;

/** Shape returned by {@link probeImageFailure}. */
interface ImageFailureProbe {
  failed: boolean;
  canRetry: boolean;
}

/**
 * One-round-trip probe: does the LAST assistant turn carry a generation
 * failure, and is a "Try again" / "Retry" button present? Scoped to the
 * last turn so old failures never trigger recovery.
 */
async function probeImageFailure(
  page: ImageDriverPage,
): Promise<ImageFailureProbe | null> {
  try {
    return await page.evaluate(
      (...args: unknown[]): ImageFailureProbe => {
        const markers = args[0] as string[];
        const turns = document.querySelectorAll(
          '[data-message-author-role="assistant"]',
        );
        let failed = false;
        if (turns.length > 0) {
          const last = turns[turns.length - 1] as HTMLElement;
          const text = (last.innerText || '').toLowerCase();
          for (const marker of markers) {
            if (text.includes(marker)) {
              failed = true;
              break;
            }
          }
        }
        if (!failed) return { failed: false, canRetry: false };
        let canRetry = false;
        const buttons = document.querySelectorAll('button');
        for (let i = 0; i < buttons.length; i += 1) {
          const label = ((buttons[i] as HTMLElement).innerText || '').trim().toLowerCase();
          if (label === 'try again' || label === 'retry') {
            canRetry = true;
            break;
          }
        }
        return { failed: true, canRetry };
      },
      IMAGE_FAILURE_MARKERS,
    );
  } catch {
    return null;
  }
}

/**
 * Click ChatGPT's visible "Try again" / "Retry" button (matched by
 * visible text so class-name churn cannot break it).
 */
async function clickRetryButton(page: ImageDriverPage): Promise<boolean> {
  try {
    return await page.evaluate((): boolean => {
      const buttons = document.querySelectorAll('button');
      for (let i = 0; i < buttons.length; i += 1) {
        const button = buttons[i] as HTMLElement;
        const label = (button.innerText || '').trim().toLowerCase();
        if (label === 'try again' || label === 'retry') {
          button.click();
          return true;
        }
      }
      return false;
    });
  } catch {
    return false;
  }
}

// ─── Network interception ───────────────────────────────────────────────────

/**
 * Live capture of network image responses observed during a single
 * {@link generateImage} call. Backed by a single `page.on('response')`
 * subscription installed in {@link installNetworkInterceptor}.
 */
interface NetworkCapture {
  /**
   * Return the next captured image and remove it from the queue, or
   * `null` when nothing has been captured yet.
   */
  consume(): {
    mediaType: ImageMime;
    base64: string;
    byteLength: number;
  } | null;
  /** Detach the listener and free buffered captures. */
  dispose(): void;
}

/**
 * Subscribe to the page's `response` event for the duration of one
 * image-generation call. Filters responses by content-type, byte size,
 * and URL denylist; on a qualifying hit, reads the body and base64-
 * encodes it.
 *
 * Returns a no-op {@link NetworkCapture} when `page.on` is unavailable
 * (test stubs) so the rest of {@link generateImage} runs unchanged.
 */
function installNetworkInterceptor(
  page: ImageDriverPage,
  requestId: RequestId,
): NetworkCapture {
  const queue: {
    mediaType: ImageMime;
    base64: string;
    byteLength: number;
  }[] = [];
  let detached = false;

  if (typeof page.on !== 'function' || typeof page.off !== 'function') {
    return {
      consume: () => null,
      dispose: () => {
        /* no-op */
      },
    };
  }

  const onResponse = (resp: ImageDriverResponse): void => {
    if (detached) return;
    void handleResponse(resp);
  };

  const handleResponse = async (resp: ImageDriverResponse): Promise<void> => {
    if (detached) return;
    let url: string;
    try {
      url = resp.url();
    } catch {
      return;
    }
    const lowerUrl = url.toLowerCase();

    // Allowlist gate — must come from a known generated-image
    // delivery endpoint.
    let allowed = false;
    for (const allowedFragment of URL_ALLOWLIST) {
      if (lowerUrl.includes(allowedFragment)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) return;

    // Denylist gate — known UI-asset URL patterns.
    for (const denied of URL_DENYLIST) {
      if (lowerUrl.includes(denied)) return;
    }

    let okStatus: boolean;
    try {
      okStatus = resp.ok();
    } catch {
      return;
    }
    if (!okStatus) return;

    let headers: Record<string, string>;
    try {
      headers = resp.headers();
    } catch {
      return;
    }
    const rawType = (headers['content-type'] ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
    const mediaType = normalizeMime(rawType);
    if (mediaType === null) return;

    // Cheap size filter via Content-Length when present.
    const declaredLengthRaw = headers['content-length'];
    if (declaredLengthRaw !== undefined && declaredLengthRaw !== '') {
      const declaredLength = Number.parseInt(declaredLengthRaw, 10);
      if (Number.isFinite(declaredLength)) {
        if (declaredLength < MIN_NETWORK_IMAGE_BYTES_STRICT) return;
        if (declaredLength > MAX_IMAGE_BYTES) return;
      }
    }

    let bytes: Uint8Array;
    try {
      bytes = await resp.buffer();
    } catch {
      return;
    }
    if (detached) return;
    if (bytes.byteLength < MIN_NETWORK_IMAGE_BYTES_STRICT) return;
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      logAgentEvent({
        eventType: 'agent.error',
        errorCategory: 'image_too_large',
        requestId,
        bytes: bytes.byteLength,
      });
      return;
    }

    // Pixel-dimension check — generated images are ≥ 700 px on both
    // axes; UI icons that survive the size filter are smaller.
    if (mediaType === 'image/png') {
      const dims = readPngDimensions(bytes);
      if (dims === null) return; // malformed PNG — skip
      if (dims.width < MIN_GENERATED_PIXEL_DIM || dims.height < MIN_GENERATED_PIXEL_DIM) {
        // Still log so future debugging can see what we rejected.
        logAgentEvent({
          eventType: 'agent.error',
          errorCategory: 'image_rejected_dimension',
          requestId,
          bytes: bytes.byteLength,
          width: dims.width,
          height: dims.height,
          url: url.length > 200 ? url.slice(0, 200) + '...' : url,
        });
        return;
      }
    }
    // Non-PNG MIMEs (jpeg/webp/gif) — the byte-size filter (≥ 100 KB)
    // handles them.

    logAgentEvent({
      eventType: 'agent.image_captured',
      requestId,
      source: 'network',
      bytes: bytes.byteLength,
      url: url.length > 200 ? url.slice(0, 200) + '...' : url,
    });

    const base64 = encodeBase64(bytes);
    queue.push({ mediaType, base64, byteLength: bytes.byteLength });
  };

  try {
    page.on('response', onResponse);
  } catch {
    return {
      consume: () => null,
      dispose: () => {
        /* no-op */
      },
    };
  }

  return {
    consume: () => queue.shift() ?? null,
    dispose: () => {
      if (detached) return;
      detached = true;
      try {
        page.off?.('response', onResponse);
      } catch {
        /* best effort */
      }
      queue.length = 0;
    },
  };
}

/**
 * Encode a `Uint8Array` to a standard-alphabet base64 string. Uses
 * Node's built-in `Buffer` when available (production); falls back to
 * a chunked `btoa` implementation for environments without `Buffer`.
 */
function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(bytes).toString('base64');
  }
  // Fallback path — chunked to keep the call stack bounded on a
  // 25 MB image.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  const g = globalThis as unknown as { btoa?: (s: string) => string };
  if (typeof g.btoa === 'function') return g.btoa(binary);
  throw new Error('no base64 encoder available');
}

/**
 * Read the pixel width and height encoded in the IHDR chunk of a PNG
 * file. Returns `null` if the buffer is too short or does not start
 * with the canonical 8-byte PNG signature.
 */
function readPngDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return null;
  }
  // IHDR type at bytes 12-15: 'I','H','D','R'
  if (
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return null;
  }
  const width =
    ((bytes[16] ?? 0) << 24) |
    ((bytes[17] ?? 0) << 16) |
    ((bytes[18] ?? 0) << 8) |
    (bytes[19] ?? 0);
  const height =
    ((bytes[20] ?? 0) << 24) |
    ((bytes[21] ?? 0) << 16) |
    ((bytes[22] ?? 0) << 8) |
    (bytes[23] ?? 0);
  if (width <= 0 || height <= 0) return null;
  return { width: width >>> 0, height: height >>> 0 };
}

// ─── In-page DOM fallback ───────────────────────────────────────────────────

/**
 * Install a MutationObserver inside the page that watches for new
 * qualifying `<img>` elements and stores `{ src, naturalWidth,
 * naturalHeight }` of the first match on `window.__kiroImage`.
 * Idempotent across calls. Errors are swallowed.
 */
async function installImageObserver(
  page: ImageDriverPage,
  minDim: number,
): Promise<void> {
  try {
    await page.evaluate((...args: unknown[]): void => {
      const minDimLocal = args[0] as number;
      type ObserverResult = { src: string; width: number; height: number };
      const w = window as unknown as {
        __kiroImage?: ObserverResult | null;
        __kiroImageObserver?: MutationObserver | null;
      };
      if (w.__kiroImageObserver !== null && w.__kiroImageObserver !== undefined) {
        try {
          w.__kiroImageObserver.disconnect();
        } catch {
          /* best effort */
        }
      }
      w.__kiroImage = null;

      const isQualifyingSrc = (src: string): boolean => {
        if (src.length === 0) return false;
        if (src.startsWith('https://')) return true;
        if (src.startsWith('blob:')) return true;
        if (src.startsWith('data:image/')) return true;
        return false;
      };

      const consider = (img: HTMLImageElement): void => {
        if (w.__kiroImage !== null && w.__kiroImage !== undefined) return;
        if (!isQualifyingSrc(img.src)) return;
        const finalize = (): void => {
          if (w.__kiroImage !== null && w.__kiroImage !== undefined) return;
          if (img.naturalWidth < minDimLocal || img.naturalHeight < minDimLocal) {
            return;
          }
          w.__kiroImage = {
            src: img.src,
            width: img.naturalWidth,
            height: img.naturalHeight,
          };
        };
        if (img.complete && img.naturalWidth > 0) {
          finalize();
        } else {
          img.addEventListener('load', finalize, { once: true });
        }
      };

      // INTENTIONALLY DO NOT consider() pre-existing <img> elements.
      // The DOM-fallback path is for *newly added* generated images;
      // any image already in the DOM at observer-install time is a UI
      // asset, never the output we are about to ask for.
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (let i = 0; i < m.addedNodes.length; i += 1) {
            const node = m.addedNodes[i];
            if (node instanceof HTMLImageElement) {
              consider(node);
            } else if (node instanceof Element) {
              const nested = node.querySelectorAll('img');
              for (let j = 0; j < nested.length; j += 1) {
                consider(nested[j] as HTMLImageElement);
              }
            }
          }
          if (
            m.type === 'attributes' &&
            m.target instanceof HTMLImageElement &&
            m.attributeName === 'src'
          ) {
            consider(m.target);
          }
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src'],
      });
      w.__kiroImageObserver = observer;
    }, minDim);
  } catch {
    /* best effort */
  }
}

/**
 * Read `window.__kiroImage` and return the captured `{ src }`, or
 * `null` when the observer has not seen a qualifying image yet.
 */
async function readObserverResult(
  page: ImageDriverPage,
): Promise<{ src: string } | null> {
  try {
    return await page.evaluate((): { src: string } | null => {
      const w = window as unknown as {
        __kiroImage?: { src: string; width: number; height: number } | null;
      };
      const r = w.__kiroImage;
      if (r === null || r === undefined) return null;
      return { src: r.src };
    });
  } catch {
    return null;
  }
}

/**
 * Reset `window.__kiroImage` to `null` so the next observer hit
 * surfaces afresh.
 */
async function clearObserverResult(page: ImageDriverPage): Promise<void> {
  try {
    await page.evaluate((): void => {
      const w = window as unknown as { __kiroImage?: unknown };
      w.__kiroImage = null;
    });
  } catch {
    /* best effort */
  }
}

/**
 * Fallback DOM scan — walks {@link SEL.GENERATED_IMAGE} fallbacks, then
 * a generic "any qualifying `<img>` inside the last assistant turn"
 * probe.
 */
async function scanForImage(
  page: ImageDriverPage,
  minDim: number,
): Promise<{ src: string } | null> {
  for (const selector of SEL.GENERATED_IMAGE) {
    let candidate: { src: string; w: number; h: number } | null = null;
    try {
      candidate = await page.evaluate(
        (...args: unknown[]): { src: string; w: number; h: number } | null => {
          const sel = args[0] as string;
          const el = document.querySelector(sel);
          if (el instanceof HTMLImageElement) {
            const src = el.src ?? '';
            const ok =
              src.startsWith('https://') ||
              src.startsWith('blob:') ||
              src.startsWith('data:image/');
            if (!ok) return null;
            return { src, w: el.naturalWidth, h: el.naturalHeight };
          }
          return null;
        },
        selector,
      );
    } catch {
      continue;
    }
    if (candidate === null) continue;
    if (candidate.w < minDim || candidate.h < minDim) continue;
    return { src: candidate.src };
  }

  try {
    const found = await page.evaluate(
      (...args: unknown[]): { src: string } | null => {
        const minDimLocal = args[0] as number;
        const turns = document.querySelectorAll(
          '[data-message-author-role="assistant"]',
        );
        if (turns.length === 0) return null;
        const last = turns[turns.length - 1] as HTMLElement;
        const images = last.querySelectorAll('img');
        for (let i = 0; i < images.length; i += 1) {
          const img = images[i] as HTMLImageElement;
          const src = img.src ?? '';
          const ok =
            src.startsWith('https://') ||
            src.startsWith('blob:') ||
            src.startsWith('data:image/');
          if (!ok) continue;
          if (img.naturalWidth < minDimLocal || img.naturalHeight < minDimLocal) continue;
          return { src };
        }
        return null;
      },
      minDim,
    );
    return found;
  } catch {
    return null;
  }
}

/**
 * Fetch `src` inside the page context and base64-encode the bytes.
 */
async function fetchAndEncode(
  page: ImageDriverPage,
  src: string,
): Promise<{ mime: string; base64: string } | null> {
  try {
    return await page.evaluate(
      async (...args: unknown[]): Promise<{ mime: string; base64: string } | null> => {
        const url = args[0] as string;
        try {
          const resp = await fetch(url);
          if (!resp.ok) return null;
          const blob = await resp.blob();
          const ab = await blob.arrayBuffer();
          const bytes = new Uint8Array(ab);
          let binary = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
            binary += String.fromCharCode.apply(null, Array.from(slice));
          }
          return { mime: blob.type, base64: btoa(binary) };
        } catch {
          return null;
        }
      },
      src,
    );
  } catch {
    return null;
  }
}

/**
 * Coerce a raw `Blob.type` / Content-Type string into one of the four
 * wire-compatible {@link ImageMime} values, or `null` when the type is
 * unrecognised.
 */
function normalizeMime(raw: string): ImageMime | null {
  const lower = raw.toLowerCase().trim();
  if (lower === 'image/png') return 'image/png';
  if (lower === 'image/jpeg' || lower === 'image/jpg') return 'image/jpeg';
  if (lower === 'image/webp') return 'image/webp';
  if (lower === 'image/gif') return 'image/gif';
  return null;
}
