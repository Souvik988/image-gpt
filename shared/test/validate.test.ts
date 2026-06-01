import { describe, it, expect } from 'vitest';
import {
  validateRequest,
  validateStreamChunk,
  validateCancelSignal,
  validateAgentHeartbeat,
  validateClientHandshake,
  validateAgentHandshake,
  type ValidateErr,
} from '../src/validate.js';

/**
 * Unit tests for `shared/src/validate.ts`. Implements R26.5 / R26.6 by
 * exercising:
 *  - prompt-length bounds (chat 1..32000, image 1..4000),
 *  - missing required fields,
 *  - oversize attachments (encoded length above the 25 MB-equivalent cap),
 *  - history length cap (0..200),
 *  - protocolVersion mismatch (must be the literal `1`),
 *  - malformed types (wrong shape, wrong primitives),
 * and asserts that on every failure the result carries a populated
 * `firstFailingField` (dotted path) and `rule` (`code: message`).
 *
 * Each test starts from a known-good fixture and mutates exactly one
 * field so the failure attribution is unambiguous.
 */

// ─── Fixtures ──────────────────────────────────────────────────────────────

const SUBMITTED_AT = 1_700_000_000_000;

function validChatRequest(): Record<string, unknown> {
  return {
    protocolVersion: 1,
    requestId: '11111111-1111-1111-1111-111111111111',
    clientId: 'client-0123456789abcdef',
    sessionId: 'sess-0123456789abcdef',
    type: 'chat',
    prompt: 'hello',
    submittedAt: SUBMITTED_AT,
  };
}

function validImageRequest(): Record<string, unknown> {
  return {
    protocolVersion: 1,
    requestId: '22222222-2222-2222-2222-222222222222',
    clientId: 'client-0123456789abcdef',
    sessionId: 'sess-0123456789abcdef',
    type: 'image',
    prompt: 'a watercolor cat',
    submittedAt: SUBMITTED_AT,
  };
}

function validStreamChunk(): Record<string, unknown> {
  return {
    protocolVersion: 1,
    requestId: '11111111-1111-1111-1111-111111111111',
    chunkIndex: 0,
    text: 'partial',
    isFinal: false,
  };
}

/** Narrow a {@link ValidateResult} to its failure arm with a clear message. */
function expectFailure<T>(
  result: { ok: true; value: T } | ValidateErr,
): asserts result is ValidateErr {
  if (result.ok) {
    throw new Error(`expected validation failure, got success: ${JSON.stringify(result.value)}`);
  }
}

// ─── validateRequest — prompt length ───────────────────────────────────────

describe('validateRequest — prompt length bounds', () => {
  it('accepts a chat prompt of length 1', () => {
    const input = { ...validChatRequest(), prompt: 'x' };
    const result = validateRequest(input);
    expect(result.ok).toBe(true);
  });

  it('accepts a chat prompt of length 32000 (upper bound)', () => {
    const input = { ...validChatRequest(), prompt: 'a'.repeat(32_000) };
    const result = validateRequest(input);
    expect(result.ok).toBe(true);
  });

  it('rejects an empty chat prompt with firstFailingField = "prompt"', () => {
    const input = { ...validChatRequest(), prompt: '' };
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('prompt');
    expect(result.rule.length).toBeGreaterThan(0);
  });

  it('rejects a chat prompt of length 32001', () => {
    const input = { ...validChatRequest(), prompt: 'a'.repeat(32_001) };
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('prompt');
    expect(result.rule).toMatch(/too_big|max/i);
  });

  it('accepts an image prompt of length 4000 (upper bound)', () => {
    const input = { ...validImageRequest(), prompt: 'x'.repeat(4_000) };
    const result = validateRequest(input);
    expect(result.ok).toBe(true);
  });

  it('rejects an image prompt of length 4001', () => {
    const input = { ...validImageRequest(), prompt: 'x'.repeat(4_001) };
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('prompt');
    expect(result.rule).toMatch(/too_big|max/i);
  });

  it('rejects an empty image prompt (R10.7)', () => {
    const input = { ...validImageRequest(), prompt: '' };
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('prompt');
  });
});

// ─── validateRequest — missing required fields ─────────────────────────────

describe('validateRequest — missing required fields', () => {
  it('rejects when requestId is missing', () => {
    const input = validChatRequest();
    delete (input as Record<string, unknown>).requestId;
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('requestId');
    expect(result.rule.length).toBeGreaterThan(0);
  });

  it('rejects when clientId is missing', () => {
    const input = validChatRequest();
    delete (input as Record<string, unknown>).clientId;
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('clientId');
  });

  it('rejects when sessionId is missing', () => {
    const input = validChatRequest();
    delete (input as Record<string, unknown>).sessionId;
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('sessionId');
  });

  it('rejects when submittedAt is missing', () => {
    const input = validChatRequest();
    delete (input as Record<string, unknown>).submittedAt;
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('submittedAt');
  });

  it('rejects when type is missing (discriminator)', () => {
    const input = validChatRequest();
    delete (input as Record<string, unknown>).type;
    const result = validateRequest(input);
    expectFailure(result);
    // Discriminated-union dispatch surfaces the missing discriminator
    // under the `type` path.
    expect(result.firstFailingField).toBe('type');
  });

  it('rejects when prompt is missing', () => {
    const input = validChatRequest();
    delete (input as Record<string, unknown>).prompt;
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('prompt');
  });
});

// ─── validateRequest — oversize attachments ────────────────────────────────

describe('validateRequest — oversize attachments', () => {
  it('rejects an attachment whose base64 length implies > 25 MB after decode', () => {
    // 35,000,001 chars is the smallest length that exceeds the 25 MiB
    // pre-decode bound enforced by the schema.
    const input = {
      ...validChatRequest(),
      attachments: [
        {
          filename: 'huge.bin',
          mimeType: 'application/octet-stream',
          base64: 'A'.repeat(35_000_001),
        },
      ],
    };
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('attachments.0.base64');
    expect(result.rule.length).toBeGreaterThan(0);
  });

  it('rejects an attachment with empty filename', () => {
    const input = {
      ...validChatRequest(),
      attachments: [{ filename: '', mimeType: 'image/png', base64: 'aGVsbG8=' }],
    };
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('attachments.0.filename');
  });
});

// ─── validateRequest — history length cap ──────────────────────────────────

describe('validateRequest — history length', () => {
  function historyEntry(i: number): Record<string, unknown> {
    return { role: i % 2 === 0 ? 'user' : 'assistant', text: `msg ${i}`, createdAt: i };
  }

  it('accepts history with 200 entries (upper bound)', () => {
    const input = {
      ...validChatRequest(),
      history: Array.from({ length: 200 }, (_, i) => historyEntry(i)),
    };
    const result = validateRequest(input);
    expect(result.ok).toBe(true);
  });

  it('rejects history with 201 entries', () => {
    const input = {
      ...validChatRequest(),
      history: Array.from({ length: 201 }, (_, i) => historyEntry(i)),
    };
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('history');
    expect(result.rule).toMatch(/too_big|max/i);
  });

  it('rejects a history entry with an unknown role', () => {
    const input = {
      ...validChatRequest(),
      history: [{ role: 'system', text: 'nope', createdAt: 0 }],
    };
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('history.0.role');
  });
});

// ─── validateRequest — protocolVersion mismatch ────────────────────────────

describe('validateRequest — protocolVersion mismatch', () => {
  it('rejects protocolVersion 0', () => {
    const input = { ...validChatRequest(), protocolVersion: 0 };
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('protocolVersion');
  });

  it('rejects protocolVersion 2', () => {
    const input = { ...validChatRequest(), protocolVersion: 2 };
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('protocolVersion');
  });

  it('rejects protocolVersion of wrong primitive type', () => {
    const input = { ...validChatRequest(), protocolVersion: '1' };
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('protocolVersion');
  });
});

// ─── validateRequest — malformed types ─────────────────────────────────────

describe('validateRequest — malformed types', () => {
  it('rejects a non-object root', () => {
    const result = validateRequest('not an object');
    expectFailure(result);
    expect(result.rule.length).toBeGreaterThan(0);
  });

  it('rejects null', () => {
    const result = validateRequest(null);
    expectFailure(result);
    expect(result.rule.length).toBeGreaterThan(0);
  });

  it('rejects an unknown discriminator value', () => {
    const input = { ...validChatRequest(), type: 'audio' };
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('type');
  });

  it('rejects a numeric requestId', () => {
    const input = { ...validChatRequest(), requestId: 42 };
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('requestId');
  });

  it('rejects a non-integer submittedAt', () => {
    const input = { ...validChatRequest(), submittedAt: 1.5 };
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('submittedAt');
  });

  it('rejects an unknown origin tag (closed enum)', () => {
    const input = { ...validChatRequest(), origin: 'unknown-source' };
    const result = validateRequest(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('origin');
  });
});

// ─── validateStreamChunk ───────────────────────────────────────────────────

describe('validateStreamChunk', () => {
  it('accepts a minimal valid chunk', () => {
    const result = validateStreamChunk(validStreamChunk());
    expect(result.ok).toBe(true);
  });

  it('rejects a negative chunkIndex with the right path', () => {
    const input = { ...validStreamChunk(), chunkIndex: -1 };
    const result = validateStreamChunk(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('chunkIndex');
  });

  it('rejects an unknown errorCode (closed enum)', () => {
    const input = { ...validStreamChunk(), errorCode: 'NOT_A_CODE' };
    const result = validateStreamChunk(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('errorCode');
  });

  it('rejects an unknown mediaType', () => {
    const input = { ...validStreamChunk(), isFinal: true, mediaType: 'image/svg+xml' };
    const result = validateStreamChunk(input);
    expectFailure(result);
    expect(result.firstFailingField).toBe('mediaType');
  });

  it('accepts a final image chunk with a known mediaType', () => {
    const input = {
      ...validStreamChunk(),
      isFinal: true,
      mediaType: 'image/png',
      base64: 'aGVsbG8=',
      status: 'completed' as const,
    };
    const result = validateStreamChunk(input);
    expect(result.ok).toBe(true);
  });
});

// ─── Other top-level validators ────────────────────────────────────────────

describe('validateCancelSignal', () => {
  it('accepts a well-formed cancel signal', () => {
    const result = validateCancelSignal({
      protocolVersion: 1,
      requestId: '11111111-1111-1111-1111-111111111111',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a missing requestId', () => {
    const result = validateCancelSignal({ protocolVersion: 1 });
    expectFailure(result);
    expect(result.firstFailingField).toBe('requestId');
  });
});

describe('validateAgentHeartbeat', () => {
  it('accepts a well-formed heartbeat', () => {
    const result = validateAgentHeartbeat({
      protocolVersion: 1,
      agentId: 'agent-abc',
      emittedAt: 1,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a non-integer emittedAt', () => {
    const result = validateAgentHeartbeat({
      protocolVersion: 1,
      agentId: 'agent-abc',
      emittedAt: 'now',
    });
    expectFailure(result);
    expect(result.firstFailingField).toBe('emittedAt');
  });
});

describe('validateClientHandshake', () => {
  it('accepts a well-formed client handshake', () => {
    const result = validateClientHandshake({
      kiroSecret: 'a'.repeat(16),
      clientVersion: '1.0.0',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects when kiroSecret is missing', () => {
    const result = validateClientHandshake({ clientVersion: '1.0.0' });
    expectFailure(result);
    expect(result.firstFailingField).toBe('kiroSecret');
  });
});

describe('validateAgentHandshake', () => {
  it('accepts a well-formed agent handshake', () => {
    const result = validateAgentHandshake({
      agentSecret: 'a'.repeat(16),
      agentVersion: '1.0.0',
      capabilities: { chat: true, image: true },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects capabilities.chat = false (closed contract)', () => {
    const result = validateAgentHandshake({
      agentSecret: 'a'.repeat(16),
      agentVersion: '1.0.0',
      capabilities: { chat: false, image: true },
    });
    expectFailure(result);
    expect(result.firstFailingField).toBe('capabilities.chat');
  });
});
