/**
 * Unit tests for `imageDriver.ts` validation branches.
 *
 * Covers:
 *  - Empty prompt → INVALID_PROMPT without DOM interaction (R10.7)
 *  - Whitespace-only prompt → INVALID_PROMPT without DOM interaction (R10.7)
 *  - Prompt >4000 chars → INVALID_PROMPT without DOM interaction (R10.7)
 *  - page.url() === 'about:blank' → CHATGPT_UNAVAILABLE (R10.8)
 *  - page.url() === '' → CHATGPT_UNAVAILABLE (R10.8)
 *
 * _Implements: R10.5, R10.6, R10.7, R10.8_
 */

import { describe, it, expect } from 'vitest';
import { generateImage, type ImageDriverPage } from '../src/browser/imageDriver.js';

// ─── Stub page infrastructure ───────────────────────────────────────────────

interface StubPageOptions {
  url?: string;
  /** If true, waitForSelector always resolves (input found). */
  inputAvailable?: boolean;
  /** Track whether any DOM interaction occurred. */
  interactions?: string[];
}

function createStubImagePage(opts: StubPageOptions = {}): ImageDriverPage {
  const interactions = opts.interactions ?? [];
  const urlValue = opts.url ?? 'https://chat.openai.com/c/test';

  return {
    url(): string {
      return urlValue;
    },
    async evaluate<R>(_fn: (...args: unknown[]) => R | Promise<R>, ..._args: unknown[]): Promise<R> {
      interactions.push('evaluate');
      return null as unknown as R;
    },
    async waitForSelector(selector: string, _opts: { timeout: number }): Promise<unknown> {
      interactions.push(`waitForSelector:${selector}`);
      if (opts.inputAvailable === false) {
        throw new Error('Timeout waiting for selector');
      }
      return {};
    },
    async $(selector: string): Promise<unknown> {
      interactions.push(`$:${selector}`);
      return null;
    },
    async click(selector: string): Promise<void> {
      interactions.push(`click:${selector}`);
    },
    keyboard: {
      async down(key: string): Promise<void> { interactions.push(`keyboard.down:${key}`); },
      async up(key: string): Promise<void> { interactions.push(`keyboard.up:${key}`); },
      async press(key: string): Promise<void> { interactions.push(`keyboard.press:${key}`); },
      async type(text: string, _opts?: { delay?: number }): Promise<void> { interactions.push(`keyboard.type:${text.slice(0, 20)}`); },
    },
    async type(selector: string, text: string, _opts?: { delay?: number }): Promise<void> {
      interactions.push(`type:${selector}:${text.slice(0, 20)}`);
    },
    async goto(url: string, _opts?: { waitUntil?: string }): Promise<unknown> {
      interactions.push(`goto:${url}`);
      return null;
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('imageDriver validation branches', () => {
  describe('INVALID_PROMPT (R10.7)', () => {
    it('empty string prompt → INVALID_PROMPT without DOM interaction', async () => {
      const interactions: string[] = [];
      const page = createStubImagePage({ interactions });

      const result = await generateImage(page, '', 'req-empty', {
        sleep: async () => {},
        now: () => 0,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe('INVALID_PROMPT');
      }
      // No DOM interactions should have occurred
      expect(interactions).toHaveLength(0);
    });

    it('whitespace-only prompt → INVALID_PROMPT without DOM interaction', async () => {
      const interactions: string[] = [];
      const page = createStubImagePage({ interactions });

      const result = await generateImage(page, '   \t\n  ', 'req-whitespace', {
        sleep: async () => {},
        now: () => 0,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe('INVALID_PROMPT');
      }
      expect(interactions).toHaveLength(0);
    });

    it('prompt exceeding 4000 characters → INVALID_PROMPT without DOM interaction', async () => {
      const interactions: string[] = [];
      const page = createStubImagePage({ interactions });
      const longPrompt = 'x'.repeat(4001);

      const result = await generateImage(page, longPrompt, 'req-long', {
        sleep: async () => {},
        now: () => 0,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe('INVALID_PROMPT');
      }
      expect(interactions).toHaveLength(0);
    });

    it('prompt of exactly 4000 characters is accepted (not INVALID_PROMPT)', async () => {
      const interactions: string[] = [];
      const page = createStubImagePage({
        interactions,
        inputAvailable: true,
      });
      const exactPrompt = 'x'.repeat(4000);
      let time = 0;

      const result = await generateImage(page, exactPrompt, 'req-exact', {
        timeoutMs: 100,
        pollIntervalMs: 50,
        sleep: async (ms: number) => { time += ms; },
        now: () => time,
      });

      // Should NOT be INVALID_PROMPT — it may timeout or succeed depending
      // on the mock, but the validation gate should pass
      if (!result.ok) {
        expect(result.errorCode).not.toBe('INVALID_PROMPT');
      }
    });

    it('prompt of exactly 1 character is accepted (not INVALID_PROMPT)', async () => {
      const interactions: string[] = [];
      const page = createStubImagePage({
        interactions,
        inputAvailable: true,
      });
      let time = 0;

      const result = await generateImage(page, 'a', 'req-single', {
        timeoutMs: 100,
        pollIntervalMs: 50,
        sleep: async (ms: number) => { time += ms; },
        now: () => time,
      });

      if (!result.ok) {
        expect(result.errorCode).not.toBe('INVALID_PROMPT');
      }
    });
  });

  describe('CHATGPT_UNAVAILABLE (R10.8)', () => {
    it('page at about:blank → CHATGPT_UNAVAILABLE', async () => {
      const interactions: string[] = [];
      const page = createStubImagePage({ url: 'about:blank', interactions });

      const result = await generateImage(page, 'draw a cat', 'req-blank', {
        sleep: async () => {},
        now: () => 0,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe('CHATGPT_UNAVAILABLE');
      }
      // Should not have attempted to type or submit
      const typingInteractions = interactions.filter(
        (i) => i.startsWith('keyboard.type') || i.startsWith('click') || i.startsWith('waitForSelector'),
      );
      expect(typingInteractions).toHaveLength(0);
    });

    it('page with empty URL → CHATGPT_UNAVAILABLE', async () => {
      const page = createStubImagePage({ url: '' });

      const result = await generateImage(page, 'draw a dog', 'req-empty-url', {
        sleep: async () => {},
        now: () => 0,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe('CHATGPT_UNAVAILABLE');
      }
    });

    it('page.url() throws → CHATGPT_UNAVAILABLE', async () => {
      const page: ImageDriverPage = {
        url(): string {
          throw new Error('Target closed');
        },
        async evaluate<R>(_fn: (...args: unknown[]) => R | Promise<R>, ..._args: unknown[]): Promise<R> {
          return null as unknown as R;
        },
        async waitForSelector(_selector: string, _opts: { timeout: number }): Promise<unknown> {
          return {};
        },
        async $(_selector: string): Promise<unknown> {
          return null;
        },
        async click(_selector: string): Promise<void> {},
        keyboard: {
          async down(_key: string): Promise<void> {},
          async up(_key: string): Promise<void> {},
          async press(_key: string): Promise<void> {},
          async type(_text: string, _opts?: { delay?: number }): Promise<void> {},
        },
        async type(_selector: string, _text: string, _opts?: { delay?: number }): Promise<void> {},
      };

      const result = await generateImage(page, 'draw something', 'req-throw', {
        sleep: async () => {},
        now: () => 0,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe('CHATGPT_UNAVAILABLE');
      }
    });
  });
});
