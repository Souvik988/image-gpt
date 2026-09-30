/**
 * API driver — generates images through ChatGPT's same-origin backend
 * conversation endpoint, executed INSIDE the loaded page.
 *
 * Why this exists (Phase 8 anti-detection): the DOM driver types into
 * the composer and scrapes the page — every interaction is visible to
 * anti-bot instrumentation. This driver instead performs authenticated
 * `fetch` calls from the page's own origin:
 *
 *   1. `GET /api/auth/session`  → the browser's session access token.
 *   2. `POST /backend-api/conversation` (SSE) with `force_paragen: true`
 *      → routes the prompt to the image tool.
 *   3. Parse the event stream for an `image_asset_pointer` part.
 *   4. `GET <file-service URL>/download` (same-origin, cookies included)
 *      → raw image bytes → base64.
 *
 * Because every request carries the page's real cookies, real TLS
 * fingerprint, and real Cloudflare clearance, nothing here trips the
 * bot checks that DOM automation does. The DOM driver remains as the
 * fallback when this contract drifts.
 *
 * @packageDocumentation
 */

/** Structural page surface the API driver needs (subset of puppeteer). */
export interface ApiDriverPage {
  evaluate<R>(fn: (...args: unknown[]) => R | Promise<R>, ...args: unknown[]): Promise<R>;
}

export interface ApiImageOptions {
  /** In-page generation deadline in ms. Default 420000 (7 min). */
  timeoutMs?: number;
}

export type ApiImageResult =
  | { ok: true; base64: string; mime: string }
  | { ok: false; code: string; detail?: string };

/** The in-page routine (serialized into the page; no outer closures). */
async function pageRoutine(...args: unknown[]): Promise<ApiImageResult> {
  {
    const prompt = args[0] as string;
    const timeoutMs = (args[1] as number) ?? 420_000;
    const w = window as unknown as {
      __kiroApiBusy?: boolean;
      crypto: Crypto;
    };
    if (w.__kiroApiBusy === true) return { ok: false, code: 'BUSY' };
    w.__kiroApiBusy = true;

    const uuid = (): string => {
      const c = w.crypto;
      if (typeof c !== 'undefined' && typeof c.randomUUID === 'function') {
        return c.randomUUID();
      }
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
        const r = (Math.random() * 16) | 0;
        return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
    };

    try {
      // Step 1: session access token (same-origin, cookies included).
      let token: string | undefined;
      try {
        const sess = (await fetch('/api/auth/session', {
          credentials: 'include',
        }).then((r) => r.json())) as { accessToken?: string };
        token = sess && typeof sess.accessToken === 'string' ? sess.accessToken : undefined;
      } catch {
        token = undefined;
      }
      if (!token) return { ok: false, code: 'AUTH_REQUIRED' };

      // Step 2: conversation POST (SSE) with the image tool forced.
      const body = {
        action: 'next',
        messages: [
          {
            id: uuid(),
            author: { role: 'user' },
            content: { content_type: 'text', parts: [prompt] },
            metadata: {},
          },
        ],
        model: 'auto',
        parent_message_id: uuid(),
        timezone_offset_min: -new Date().getTimezoneOffset(),
        history_and_training_disabled: false,
        conversation_mode: { kind: 'primary_assistant' },
        force_paragen: true,
        websocket_request_id: uuid(),
      };
      const resp = await fetch('/backend-api/conversation', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok || resp.body === null) {
        const detail = await resp.text().catch(() => '');
        return {
          ok: false,
          code: 'HTTP_' + resp.status,
          detail: detail.slice(0, 300),
        };
      }

      // Step 3: parse the SSE stream for an image asset pointer.
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assetPointer: string | null = null;
      let providerError: unknown = null;
      const deadline = Date.now() + timeoutMs;

      while (true) {
        if (Date.now() > deadline) {
          return { ok: false, code: 'TIMEOUT' };
        }
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload.length === 0 || payload === '[DONE]') continue;
          let event: {
            message?: {
              content?: { parts?: Array<{ content_type?: string; asset_pointer?: string }> };
            };
            error?: unknown;
          };
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }
          const parts = event.message?.content?.parts;
          if (Array.isArray(parts)) {
            for (const part of parts) {
              if (
                part &&
                part.content_type === 'image_asset_pointer' &&
                typeof part.asset_pointer === 'string'
              ) {
                assetPointer = part.asset_pointer;
              }
            }
          }
          if (event.error !== undefined && event.error !== null) {
            providerError = event.error;
          }
        }
        if (assetPointer !== null) break;
      }

      if (assetPointer === null) {
        return {
          ok: false,
          code: providerError !== null ? 'PROVIDER_ERROR' : 'NO_IMAGE',
          detail:
            providerError !== null
              ? JSON.stringify(providerError).slice(0, 300)
              : undefined,
        };
      }

      // Step 4: download the bytes (same-origin file service).
      const url = assetPointer.startsWith('file-service://')
        ? 'https://chatgpt.com/backend-api/files/' +
          assetPointer.slice('file-service://'.length) +
          '/download'
        : assetPointer;
      const imgResp = await fetch(url, { credentials: 'include' });
      if (!imgResp.ok) {
        return { ok: false, code: 'DOWNLOAD_' + imgResp.status };
      }
      const buf = await imgResp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(
          null,
          Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))),
        );
      }
      return {
        ok: true,
        base64: btoa(binary),
        mime: imgResp.headers.get('content-type') ?? 'image/png',
      };
    } finally {
      w.__kiroApiBusy = false;
    }
  }
}

export type ApiImageInternalResult =
  | { ok: true; base64: string; mime: string }
  | { ok: false; code: string; detail?: string };

/**
 * Generate an image via the same-origin conversation API. Never throws.
 */
export async function generateImageViaApi(
  page: ApiDriverPage,
  prompt: string,
  requestId: string,
  opts: ApiImageOptions = {},
): Promise<ApiImageResult> {
  const timeoutMs = opts.timeoutMs ?? 420_000;
  try {
    const raw = await page.evaluate(
      pageRoutine as unknown as (...args: unknown[]) => unknown,
      prompt,
      timeoutMs,
    );
    const result = raw as ApiImageInternalResult;
    if (result !== null && typeof result === 'object' && 'ok' in result) {
      if (result.ok === true) {
        return { ok: true, base64: result.base64, mime: result.mime };
      }
      return { ok: false, code: result.code, detail: result.detail };
    }
    return { ok: false, code: 'MALFORMED_RESPONSE' };
  } catch (e) {
    void requestId;
    return { ok: false, code: 'EVALUATE_FAILED', detail: String(e).slice(0, 200) };
  }
}
