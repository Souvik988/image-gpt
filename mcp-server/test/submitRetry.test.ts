/**
 * Unit tests for the Phase 5 policy-retry submit path in
 * `tools/common.ts`: `submitImageRequest` (chat-driven rephrase +
 * single image retry), `sanitizeRewrittenPrompt`, and
 * `readPolicyRetryBudget`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Request, StreamChunk } from '@kiro-gpt-bridge/shared';

import {
  readPolicyRetryBudget,
  sanitizeRewrittenPrompt,
  submitImageRequest,
  type McpToolContext,
} from '../src/tools/common.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const IMAGE_OK: StreamChunk = {
  protocolVersion: 1,
  requestId: 'img',
  chunkIndex: 0,
  text: '',
  isFinal: true,
  mediaType: 'image/png',
  base64: 'aGk=',
};

const POLICY_REFUSAL: StreamChunk = {
  protocolVersion: 1,
  requestId: 'img',
  chunkIndex: 0,
  text: '',
  isFinal: true,
  status: 'failed',
  errorCode: 'CONTENT_POLICY',
  message: 'cannot create that',
};

const CHAT_REWRITE: StreamChunk = {
  protocolVersion: 1,
  requestId: 'chat',
  chunkIndex: 0,
  text: 'A safe rewritten prompt',
  isFinal: true,
};

type Responder = (req: Request) => StreamChunk;

function makeCtx(responders: Responder[]): McpToolContext & { calls: Request[] } {
  const calls: Request[] = [];
  let i = 0;
  const ctx = {
    calls,
    relayClient: {
      submitAndAwait: async (req: Request): Promise<StreamChunk> => {
        calls.push(req);
        const respond = responders[Math.min(i, responders.length - 1)];
        i += 1;
        return respond(req);
      },
    },
    workspaceResolver: {},
  };
  return ctx as unknown as McpToolContext & { calls: Request[] };
}

const ENV_KEYS: string[] = ['KIRO_GPT_MCP_POLICY_RETRIES'];
const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

// ─── sanitizeRewrittenPrompt ───────────────────────────────────────────────

describe('sanitizeRewrittenPrompt', () => {
  it('strips wrapping quotes and label prefixes and collapses newlines', () => {
    expect(sanitizeRewrittenPrompt('"A safe prompt"', 'original')).toBe('A safe prompt');
    expect(sanitizeRewrittenPrompt('Rewritten prompt: A safe prompt', 'o')).toBe('A safe prompt');
    expect(sanitizeRewrittenPrompt('line one\nline two', 'o')).toBe('line one line two');
  });

  it('returns null for empty, identical, or oversized-but-unusable output', () => {
    expect(sanitizeRewrittenPrompt('', 'original')).toBeNull();
    expect(sanitizeRewrittenPrompt('   ', 'original')).toBeNull();
    expect(sanitizeRewrittenPrompt('original', 'original')).toBeNull();
  });

  it('clamps to the 4000-char wire budget', () => {
    const long = 'x'.repeat(5000);
    const out = sanitizeRewrittenPrompt(long, 'original');
    expect(out?.length).toBe(4000);
  });
});

// ─── readPolicyRetryBudget ─────────────────────────────────────────────────

describe('readPolicyRetryBudget', () => {
  it('defaults to 1 and clamps to 0..2', () => {
    delete process.env.KIRO_GPT_MCP_POLICY_RETRIES;
    expect(readPolicyRetryBudget()).toBe(1);
    process.env.KIRO_GPT_MCP_POLICY_RETRIES = '0';
    expect(readPolicyRetryBudget()).toBe(0);
    process.env.KIRO_GPT_MCP_POLICY_RETRIES = '7';
    expect(readPolicyRetryBudget()).toBe(2);
    process.env.KIRO_GPT_MCP_POLICY_RETRIES = 'abc';
    expect(readPolicyRetryBudget()).toBe(1);
  });
});

// ─── submitImageRequest ────────────────────────────────────────────────────

describe('submitImageRequest', () => {
  it('returns the first successful chunk untouched', async () => {
    const ctx = makeCtx([() => IMAGE_OK]);
    const result = await submitImageRequest(ctx, 'a prompt');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rephrased).toBe(false);
      expect(result.promptUsed).toBe('a prompt');
      expect(result.finalChunk).toBe(IMAGE_OK);
    }
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].type).toBe('image');
  });

  it('rephrases via chat and retries once on CONTENT_POLICY', async () => {
    const ctx = makeCtx([
      () => POLICY_REFUSAL,
      () => CHAT_REWRITE,
      () => IMAGE_OK,
    ]);
    const result = await submitImageRequest(ctx, 'risky prompt');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rephrased).toBe(true);
      expect(result.promptUsed).toBe('A safe rewritten prompt');
      expect(result.finalChunk).toBe(IMAGE_OK);
    }
    // image → chat → image
    expect(ctx.calls.map((c) => c.type)).toEqual(['image', 'chat', 'image']);
    expect(ctx.calls[1].prompt).toContain('risky prompt');
  });

  it('skips the retry when the rewrite equals the original prompt', async () => {
    const ctx = makeCtx([
      () => POLICY_REFUSAL,
      () => ({ ...CHAT_REWRITE, text: 'risky prompt' }),
    ]);
    const result = await submitImageRequest(ctx, 'risky prompt');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rephrased).toBe(false);
      expect(result.finalChunk).toBe(POLICY_REFUSAL);
    }
    expect(ctx.calls).toHaveLength(2); // image + chat, no second image
  });

  it('skips the retry entirely when the budget is 0', async () => {
    process.env.KIRO_GPT_MCP_POLICY_RETRIES = '0';
    const ctx = makeCtx([() => POLICY_REFUSAL]);
    const result = await submitImageRequest(ctx, 'risky prompt');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rephrased).toBe(false);
      expect(result.finalChunk).toBe(POLICY_REFUSAL);
    }
    expect(ctx.calls).toHaveLength(1);
  });

  it('maps transport errors to a structured RELAY_UNREACHABLE failure', async () => {
    const ctx = {
      calls: [],
      relayClient: {
        submitAndAwait: async (): Promise<StreamChunk> => {
          throw new Error('mcp_relay_disconnected');
        },
      },
      workspaceResolver: {},
    } as unknown as McpToolContext;
    const result = await submitImageRequest(ctx, 'a prompt');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('RELAY_UNREACHABLE');
    }
  });
});
