/**
 * Unit tests for the image-driver failure-recovery ladder: ChatGPT
 * sometimes renders an "Image generation failed" card with a "Try again"
 * button. The driver must click it (or re-submit the prompt when the
 * button is absent), bound the attempts, and still deliver the image
 * when a recovered attempt succeeds.
 */

import { describe, it, expect } from 'vitest';
import {
  generateImage,
  type ImageDriverPage,
  type ImageDriverResponse,
} from '../src/browser/imageDriver.js';

// ─── Fake network response (valid PNG header, ≥ 100 KB) ────────────────────

function fakeImageResponse(): ImageDriverResponse {
  const bytes = new Uint8Array(120_000);
  bytes[0] = 0x89; bytes[1] = 0x50; bytes[2] = 0x4e; bytes[3] = 0x47;
  bytes[4] = 0x0d; bytes[5] = 0x0a; bytes[6] = 0x1a; bytes[7] = 0x0a;
  bytes[12] = 0x49; bytes[13] = 0x48; bytes[14] = 0x44; bytes[15] = 0x52; // IHDR
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 1024); // width
  view.setUint32(20, 1024); // height
  return {
    url: () => 'https://chatgpt.com/backend-api/estuary/content?id=file_test',
    ok: () => true,
    headers: () => ({ 'content-type': 'image/png' }),
    buffer: async () => bytes,
  };
}

// ─── Stub page with source-dispatched evaluate ─────────────────────────────

interface Probe { failed: boolean; canRetry: boolean }

function createStub2(probes: Probe[]) {
  let probeIdx = 0;
  let clickCount = 0;
  let insertCount = 0;
  let responseHandler: ((r: ImageDriverResponse) => void) | null = null;

  const page: ImageDriverPage = {
    url: () => 'https://chatgpt.com/',
    waitForSelector: async () => ({}),
    $: async () => null,
    click: async () => {},
    keyboard: {
      down: async () => {},
      up: async () => {},
      press: async () => {},
      type: async () => {},
    },
    type: async () => {},
    evaluate: async (fn: (...a: unknown[]) => unknown, ...args: unknown[]): Promise<unknown> => {
      const source = fn.toString();
      if (source.includes("'try again'") || source.includes('"try again"')) {
        if (args.length === 0) {
          clickCount += 1;
          return true; // clickRetryButton
        }
        const probe = probes[Math.min(probeIdx, probes.length - 1)];
        probeIdx += 1;
        return probe; // probeImageFailure
      }
      if (source.includes('execCommand')) {
        insertCount += 1;
        return true;
      }
      if (source.includes('MutationObserver')) return undefined;
      if (source.includes('__kiroImage')) return null;
      return null;
    },
    on: ((_event: 'response', handler: (r: ImageDriverResponse) => void) => {
      responseHandler = handler;
    }) as unknown as undefined,
    off: (() => {
      responseHandler = null;
    }) as unknown as undefined,
  };

  return {
    page,
    clickCount: () => clickCount,
    insertCount: () => insertCount,
    fireImageResponse: () => {
      setImmediate(() => responseHandler?.(fakeImageResponse()));
    },
  };
}

const BASE_OPTS = {
  // Yield to the macrotask queue each cycle so the test's response timer
  // can fire between poll iterations (the no-op sleep would spin the
  // loop exclusively on microtasks and starve it).
  sleep: async () => {
    await new Promise((resolve) => setImmediate(resolve));
  },
  stabilizationQuietMs: 0,
  timeoutMs: 60_000,
  pollIntervalMs: 1,
};

describe('imageDriver failure recovery', () => {
  it('clicks Try again on failure, then delivers the image from the recovered attempt', async () => {
    const stub = createStub2([{ failed: true, canRetry: true }, { failed: false, canRetry: false }]);
    const resultPromise = generateImage(
      stub.page,
      'grocery homepage mockup',
      'req-recovery',
      BASE_OPTS,
    );
    // Fire the image on the next macrotask so it lands in the drain of
    // the cycle AFTER the recovery click.
    setTimeout(() => stub.fireImageResponse(), 5);
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mediaType).toBe('image/png');
    }
    expect(stub.clickCount()).toBe(1);
  }, 20_000);

  it('re-submits the prompt when no Try again button is present', async () => {
    // cycle1: failed, no button → resubmit; cycle2: healthy → deliver.
    const stub = createStub2([
      { failed: true, canRetry: false },
      { failed: false, canRetry: false },
    ]);
    const resultPromise = generateImage(
      stub.page,
      'grocery homepage mockup',
      'req-resubmit',
      BASE_OPTS,
    );
    setTimeout(() => stub.fireImageResponse(), 10);
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    // 1 initial insert + 1 recovery resubmit
    expect(stub.insertCount()).toBe(2);
    expect(stub.clickCount()).toBe(0);
  }, 20_000);

  it('gives up with CHATGPT_ERROR after the bounded recovery attempts', async () => {
    const stub = createStub2([{ failed: true, canRetry: false }]);
    const result = await generateImage(
      stub.page,
      'grocery homepage mockup',
      'req-exhaust',
      BASE_OPTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('CHATGPT_ERROR');
      expect(result.message).toContain('recovery attempts');
    }
  }, 20_000);
});
