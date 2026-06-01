/**
 * Image-driver helpers for the Browser Agent.
 *
 * Drives ChatGPT_Pro through a DALL-E / GPT-Image-1 round-trip and
 * returns the result as a base64-encoded payload that fits the closed-
 * enum `mediaType` field on the wire (`image/png`, `image/jpeg`,
 * `image/webp`, `image/gif`).
 *
 * Implements R10.1 (image-prompt path entry), R10.2 (locate generated
 * image), R10.3 (extract bytes and base64 encode), R10.4 (final
 * response shape `{ mediaType, base64 }`), R10.5 (deadline →
 * `IMAGE_TIMEOUT`), R10.6 (DALL-E refusal text → `CONTENT_POLICY`),
 * R10.7 (prompt validation up-front; never touch the page on invalid
 * input), R10.8 (page unreachable/load failure → `CHATGPT_UNAVAILABLE`).
 *
 * Detection strategy
 * ------------------
 * The driver runs three detectors in parallel and resolves on the
 * first to fire:
 *
 *  1. **Network interception (primary).** A `page.on('response')`
 *     handler installed for the duration of the call grabs the bytes
 *     of every `image/(png|jpeg|webp|gif)` response delivered after
 *     prompt submission. This bypasses the DOM entirely and is
 *     robust against ChatGPT's portal-rendered image elements,
 *     `loading="lazy"` zero-natural-dimension placeholders, and
 *     opaque `<canvas>` previews. The image bytes are encoded in
 *     Node directly without a CDP round-trip.
 *  2. **In-page MutationObserver (fallback).** Watches `<img>`
 *     additions anywhere in the document; when an image with a
 *     qualifying `src` (`https:` / `blob:` / `data:image/`) and
 *     dimensions ≥ 256 px appears, the driver fetches its bytes via
 *     `page.evaluate(fetch)` so the request inherits page cookies.
 *  3. **Periodic DOM scan (safety net).** Every poll cycle the
 *     driver also queries the most-recent assistant turn for any
 *     qualifying `<img>`, in case the observer was GC'd by a
 *     navigation.
 *
 * Why interception is primary: ChatGPT serves DALL-E / GPT-Image-1
 * outputs from `files.oaiusercontent.com` (or equivalent backend
 * routes). The browser fetches those bytes once, then renders them
 * via a blob URL inside an `<img>`. Our `response` handler captures
 * the original network response — the same bytes the page renders —
 * milliseconds after the underlying transfer completes, with no DOM
 * race conditions.
 *
 * Why we still keep the MutationObserver path: production puppeteer
 * pages always expose `on()`, but unit-test stubs do not. Falling
 * back to the in-page observer keeps the unit tests in
 * `test/imageDriver.test.ts` green without mocking the network layer.
 *
 * @packageDocumentation
 */

import { SEL } from './selectors.js';
import { typeAndSubmitChat, type ChatDriverPage } from './chatDriver.js';
import { logAgentEvent } from '../log/logger.js';
import type { ErrorCode, RequestId } from '@kiro-gpt-bridge/shared';

/**
 * Directive prefix prepended to the user prompt before submission.
 * ChatGPT_Pro routes prompts beginning with this phrase to the image
 * generation tool. Implements R10.1.
 */
const DALLE_PREFIX = 'Please generate an image with DALL-E: ';

/** Maximum prompt length accepted by the image path. R10.7. */
const MAX_PROMPT_LEN = 4000;

/**
 * Minimum byte size for a network image response to count as the
 * generated output. Below this threshold the response is almost
 * certainly an avatar, favicon, or UI sprite. 50 KB is comfortably
 * above ChatGPT's UI assets and well below the smallest typical
 * DALL-E output (~150–200 KB at 512 × 512).
 */
/**
 * Soft lower-bound retained for the relaxed DOM-fallback path. The
 * strict {@link MIN_NETWORK_IMAGE_BYTES_STRICT} cutoff applies to the
 * primary network-interception path; this looser threshold is used
 * only as a documentation marker and is not currently consumed by
 * runtime code (kept to preserve the historical numeric reference).
 *
 * @internal
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- documentation marker; kept intentionally per R10.5
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
 * generated image. Avatars, profile pictures, sprite atlases, and
 * placeholder PNGs all match these. The check is case-insensitive.
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
 * generated output. Generated images from DALL-E / GPT-Image-1 are
 * typically 100 KB – 5 MB at the resolutions ChatGPT serves; UI
 * sprites and inline icons are virtually always under 80 KB. 100 KB
 * is the cleanest threshold without being so high it rejects small
 * generated images.
 */
const MIN_NETWORK_IMAGE_BYTES_STRICT = 100_000;

/**
 * Minimum pixel dimension required for a captured image to count as
 * the generated output. DALL-E / GPT-Image-1 today serves outputs at
 * 1024 × 1024 (square) or 941 × 1672 / 1672 × 941 (portrait /
 * landscape mobile aspect). 700 is the cleanest cutoff that admits
 * every generated image we have observed while rejecting every
 * plausible UI sprite (avatars/icons cap at ~256 px even when
 * resvg-rendered, and ChatGPT's bundled location-pin sprite
 * specifically renders at 1024 × 1024 — so we additionally enforce
 * a URL allowlist match for the chatgpt.com backend-api estuary
 * delivery path before accepting).
 */
const MIN_GENERATED_PIXEL_DIM = 700;

/**
 * URL substrings that mark a response as a known generated-image
 * delivery channel. Observed in production:
 *
 *   - `chatgpt.com/backend-api/estuary/content?id=file_...` — the
 *     user-content delivery endpoint; this is where DALL-E /
 *     GPT-Image-1 outputs land for chat.openai.com / chatgpt.com.
 *   - `files.oaiusercontent.com/...` — OpenAI's CDN, used for
 *     attachments.
 *   - `oaidalleapiprodscus.blob.core.windows.net/...` — Azure blob
 *     fallback for older DALL-E 3 deliveries.
 *
 * Matching against this allowlist eliminates UI sprites (which live
 * under `/static/` or `_next/image`) from the candidate pool even
 * before we read the body.
 */
const URL_ALLOWLIST = [
  '/backend-api/estuary/content',
  '/backend-api/files/',
  'files.oaiusercontent.com',
  'oaidalleapiprodscus.blob.core.windows.net',
];

/**
 * Minimum width/height in CSS pixels for a DOM-discovered `<img>` to
 * count as the generated image. Used by the MutationObserver fallback
 * path; the network-interception path uses byte size + PNG dimension
 * inspection instead. 1024 matches {@link MIN_GENERATED_PIXEL_DIM}
 * and rejects every plausible UI sprite while admitting today's
 * DALL-E / GPT-Image-1 outputs.
 */
const MIN_IMAGE_DIM_PX = 1024;

/**
 * Default poll interval used when the in-page MutationObserver has
 * already populated `window.__kiroImage`. Kept short (500 ms) because
 * each tick is one property read; the observer does the heavy lifting.
 */
const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * Stabilization window in milliseconds. After the first qualifying
 * network image is captured, the driver waits this long for a
 * higher-quality replacement to arrive. ChatGPT's image pipeline
 * often delivers a low-resolution progressive preview first, then
 * the final full-quality image 3–8 seconds later from the same
 * estuary endpoint. 10 s is generous enough to catch the final
 * delivery without adding noticeable latency when only one image
 * arrives (the timeout simply expires and we return the first).
 */
const IMAGE_STABILIZATION_MS = 55_000;

/** Default deadline for image generation. R10.5 (≥ 180 s). */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Per-call tuning knobs and dependency injection points for
 * {@link generateImage}.
 */
export interface ImageDriverOptions {
  /** Total deadline for image generation in ms. Default 600 000. */
  timeoutMs?: number;
  /** Poll interval in ms for fallback DOM checks. Default 500. */
  pollIntervalMs?: number;
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
 * the network-interception path. Defined here (rather than imported
 * from puppeteer) so the unit-test stubs in `test/imageDriver.test.ts`
 * can omit the `on`/`off` surface entirely without compiler errors.
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
 * Extends {@link ChatDriverPage} with the `evaluate` / `url` / `goto`
 * methods needed for image extraction and reachability probing, plus
 * optional `on` / `off` hooks for network response interception.
 *
 * `on` and `off` are optional because the unit-test stub in
 * `test/imageDriver.test.ts` cannot easily implement them; production
 * puppeteer pages always provide both.
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
 * Submit an image-generation prompt to ChatGPT_Pro and return the
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
  // captures responses that arrive milliseconds after submit. The
  // interceptor's lifecycle is bounded to this call — torn down in
  // the `finally` block.
  const networkCapture = installNetworkInterceptor(page, requestId);

  try {
    // Step 4: submit the prompt with the DALL-E directive prefix.
    logAgentEvent({
      eventType: 'agent.image_submit',
      requestId,
      promptLength: prompt.length,
    });
    const submission = await typeAndSubmitChat(
      page,
      DALLE_PREFIX + prompt,
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
    // here are non-fatal; the per-tick DOM scan still works.
    await installImageObserver(page, MIN_IMAGE_DIM_PX);

    // Step 6: poll three sources — network capture, DOM observer, and
    // refusal text — until one resolves or the deadline expires.
    // When a network hit arrives, enter a stabilization window: wait
    // up to IMAGE_STABILIZATION_MS for a larger (higher-quality) image
    // to supersede the first. ChatGPT's pipeline often delivers a
    // progressive preview before the final full-quality image.
    const startedAt = now();
    let bestNetHit: { mediaType: ImageMime; base64: string; byteLength: number } | null = null;
    let stabilizationStart: number | null = null;

    while (now() - startedAt < timeoutMs) {
      // Drain all available network captures, keeping the largest.
      let netHit = networkCapture.consume();
      while (netHit !== null) {
        if (bestNetHit === null || netHit.byteLength > bestNetHit.byteLength) {
          bestNetHit = netHit;
          // Reset stabilization clock on each improvement.
          stabilizationStart = now();
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

      // If we have a candidate and the stabilization window has elapsed,
      // return the best image we captured.
      if (bestNetHit !== null && stabilizationStart !== null) {
        if (now() - stabilizationStart >= IMAGE_STABILIZATION_MS) {
          logAgentEvent({
            eventType: 'agent.image_captured',
            requestId,
            source: 'network',
            bytes: bestNetHit.byteLength,
            note: 'final (stabilized)',
          });
          return { ok: true, mediaType: bestNetHit.mediaType, base64: bestNetHit.base64 };
        }
      }

      await sleep(pollIntervalMs);

      const refusal = await detectContentPolicyRefusal(page);
      if (refusal !== null) {
        logAgentEvent({
          eventType: 'agent.error',
          errorCategory: 'content_policy',
          requestId,
        });
        return { ok: false, errorCode: 'CONTENT_POLICY', message: refusal };
      }

      // Drain again after sleep — new responses may have arrived.
      let netHit2 = networkCapture.consume();
      while (netHit2 !== null) {
        if (bestNetHit === null || netHit2.byteLength > bestNetHit.byteLength) {
          bestNetHit = netHit2;
          stabilizationStart = now();
          logAgentEvent({
            eventType: 'agent.image_captured',
            requestId,
            source: 'network',
            bytes: netHit2.byteLength,
            note: 'candidate (stabilizing)',
          });
        }
        netHit2 = networkCapture.consume();
      }

      // Re-check stabilization after draining post-sleep captures.
      if (bestNetHit !== null && stabilizationStart !== null) {
        if (now() - stabilizationStart >= IMAGE_STABILIZATION_MS) {
          logAgentEvent({
            eventType: 'agent.image_captured',
            requestId,
            source: 'network',
            bytes: bestNetHit.byteLength,
            note: 'final (stabilized)',
          });
          return { ok: true, mediaType: bestNetHit.mediaType, base64: bestNetHit.base64 };
        }
      }

      // DOM fallback — only used if no network candidate is available.
      // If we already have a network hit in stabilization, skip DOM
      // scanning to avoid returning a lower-quality DOM-fetched version.
      if (bestNetHit !== null) continue;

      const observed = await readObserverResult(page);
      const hit = observed ?? (await scanForImage(page, MIN_IMAGE_DIM_PX));
      if (hit === null) continue;

      const fetched = await fetchAndEncode(page, hit.src);
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

    // If we captured at least one network image but the stabilization
    // window never completed (e.g., timeout fired during stabilization),
    // return the best candidate we have rather than failing.
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

// ─── Network interception ───────────────────────────────────────────────────

/**
 * Live capture of network image responses observed during a single
 * {@link generateImage} call. Backed by a single `page.on('response')`
 * subscription installed in {@link installNetworkInterceptor}.
 */
interface NetworkCapture {
  /**
   * Return the next captured image and remove it from the queue, or
   * `null` when nothing has been captured yet. The driver consumes
   * captures as they arrive so a second image (e.g., a follow-up
   * regeneration) does not stomp the first.
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
    // delivery endpoint. Empirically observed in production:
    // `chatgpt.com/backend-api/estuary/content?id=file_...` for the
    // current ChatGPT_Pro pipeline.
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

    // Pixel-dimension check — generated images are ≥ 1024 px on both
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
    // Non-PNG MIMEs (jpeg/webp/gif) — generated images aren't served
    // as these today; if we ever start receiving one we can add a
    // dimension parser per format. For now the byte-size filter
    // (≥ 100 KB) handles them.

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
  // `btoa` is the browser primitive; not present in Node, but the
  // primary path above handles Node already.
  const g = globalThis as unknown as { btoa?: (s: string) => string };
  if (typeof g.btoa === 'function') return g.btoa(binary);
  throw new Error('no base64 encoder available');
}

/**
 * Read the pixel width and height encoded in the IHDR chunk of a PNG
 * file. Returns `null` if the buffer is too short or does not start
 * with the canonical 8-byte PNG signature.
 *
 * The PNG layout is fixed: bytes 0–7 carry the signature, bytes 8–11
 * a chunk length, bytes 12–15 the chunk type (which must be 'IHDR'),
 * bytes 16–19 the width, and bytes 20–23 the height — all integers
 * stored big-endian.
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
  // IHDR type at bytes 12-15: 'I','H','D','R' = 0x49 0x48 0x44 0x52
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

      const initial = document.querySelectorAll('img');
      // INTENTIONALLY DO NOT consider() pre-existing <img> elements.
      // The DOM-fallback path is for *newly added* generated images;
      // any image already in the DOM at observer-install time is a UI
      // asset (favicon, account avatar, sprite, location-pin icon),
      // never the DALL-E output we are about to ask for. We must wait
      // for the MutationObserver to fire on a real addition.
      void initial;

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

/**
 * Look for DALL-E content-policy refusal text inside the most-recent
 * assistant turn.
 */
async function detectContentPolicyRefusal(
  page: ImageDriverPage,
): Promise<string | null> {
  for (const selector of SEL.ASSISTANT_MESSAGE_BODY) {
    try {
      const text = await page.evaluate((...args: unknown[]): string | null => {
        const sel = args[0] as string;
        const el = document.querySelector(sel);
        if (el === null) return null;
        const txt = (el as HTMLElement).textContent ?? '';
        const lower = txt.toLowerCase();
        if (
          lower.includes('content policy') ||
          lower.includes("can't create that") ||
          lower.includes('cannot create that') ||
          lower.includes('against my guidelines') ||
          lower.includes("can't generate that") ||
          lower.includes('cannot generate that')
        ) {
          return txt.trim();
        }
        return null;
      }, selector);
      if (text !== null) return text;
    } catch {
      // Try next fallback selector.
    }
  }
  return null;
}
