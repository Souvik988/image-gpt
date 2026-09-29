/**
 * Unit tests for the Cloudflare interstitial handler: the agent must
 * click the Turnstile checkbox with human-like mouse movement and poll
 * until the challenge clears — or give up after the bounded attempts.
 */

import { describe, it, expect } from 'vitest';

import {
  isChallengeTitle,
  tryPassCloudflare,
  type CloudflarePage,
} from '../src/browser/cloudflare.js';

interface StubOptions {
  titles: string[];
  iframeBox: { x: number; y: number; width: number; height: number } | null;
  clicksToPass: number;
}

function createStub(opts: StubOptions): { page: CloudflarePage; clicks: () => number } {
  let call = 0;
  let clicks = 0;
  const page: CloudflarePage = {
    title: async () => {
      const t = opts.titles[Math.min(call, opts.titles.length - 1)];
      call += 1;
      return t;
    },
    $: async () => {
      if (opts.iframeBox === null) return null;
      return {
        boundingBox: async () => opts.iframeBox,
      };
    },
    mouse: {
      move: async () => {},
      click: async () => {
        clicks += 1;
      },
    },
  };
  return { page, clicks: () => clicks };
}

const NOOP_SLEEP = async () => {};

describe('isChallengeTitle', () => {
  it('matches the known interstitial titles', () => {
    expect(isChallengeTitle('Just a moment...')).toBe(true);
    expect(isChallengeTitle('Attention Required! | Cloudflare')).toBe(true);
    expect(isChallengeTitle('ChatGPT')).toBe(false);
    expect(isChallengeTitle('')).toBe(false);
  });
});

describe('tryPassCloudflare', () => {
  it('returns true immediately when no challenge is present', async () => {
    const stub = createStub({ titles: ['ChatGPT'], iframeBox: null, clicksToPass: 0 });
    const passed = await tryPassCloudflare(stub.page, { sleep: NOOP_SLEEP });
    expect(passed).toBe(true);
    expect(stub.clicks()).toBe(0);
  });

  it('clicks the checkbox and reports success once the title clears', async () => {
    const stub = createStub({
      // call sequence: initial check, after click 1 (still challenged), after click 2 (cleared)
      titles: ['Just a moment...', 'Just a moment...', 'ChatGPT'],
      iframeBox: { x: 120, y: 300, width: 300, height: 60 },
      clicksToPass: 2,
    });
    const passed = await tryPassCloudflare(stub.page, { sleep: NOOP_SLEEP, maxAttempts: 5 });
    expect(passed).toBe(true);
    expect(stub.clicks()).toBeGreaterThanOrEqual(2);
  });

  it('returns false when the challenge persists past the attempt budget', async () => {
    const stub = createStub({
      titles: ['Just a moment...'],
      iframeBox: { x: 120, y: 300, width: 300, height: 60 },
      clicksToPass: 0,
    });
    const passed = await tryPassCloudflare(stub.page, {
      sleep: NOOP_SLEEP,
      maxAttempts: 3,
      attemptDelayMs: 1,
    });
    expect(passed).toBe(false);
    expect(stub.clicks()).toBe(3);
  });

  it('keeps going when the checkbox iframe is absent (widget reload)', async () => {
    const stub = createStub({
      titles: ['Just a moment...', 'ChatGPT'],
      iframeBox: null,
      clicksToPass: 0,
    });
    const passed = await tryPassCloudflare(stub.page, {
      sleep: NOOP_SLEEP,
      maxAttempts: 3,
      attemptDelayMs: 1,
    });
    expect(passed).toBe(true);
    expect(stub.clicks()).toBe(0);
  });
});
