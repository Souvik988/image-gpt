// Feature: kiro-gpt-bridge, Property 5: parse(prettyPrint(x)) deep-equals x and prettyPrint is deterministic for structurally equal x,y
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { prettyPrint, parsePrettyPrinted } from '../src/prettyPrint.js';
import { base64Encode } from '../src/base64.js';
import type { Request, StreamChunk } from '../src/schema.js';

/**
 * Property 5 — pretty-printer round-trip and determinism. Validates
 * Requirements 26.1 (logical 25 MB ceiling), 26.2 (deterministic pretty
 * printer), 26.3 (round-trip safe schema), 26.4 (image and attachment
 * round-trip), and 27.4.
 *
 * Two clauses asserted on every generated example:
 *  (a) Round-trip: `parsePrettyPrinted(prettyPrint(x))` deep-equals `x`,
 *      with attachments compared first as base64 strings and then as
 *      decoded byte buffers (so any silent character mangling in the
 *      pretty-print → JSON.parse hop surfaces immediately).
 *  (b) Determinism: `prettyPrint(x) === prettyPrint(structuredClone(x))`
 *      as a UTF-8 byte comparison. `structuredClone` reorders own-property
 *      insertion non-deterministically across runtimes, so byte-equality
 *      after clone is exactly the determinism guarantee we want.
 *
 * Generators are constrained to the input space documented in the wire
 * schema: prompt 1..32000 chars (chat) / 1..4000 (image), attachments
 * each up to 1 MB raw bytes (default tier — slow tier covers 25 MB),
 * history 0..200 entries, etc. `numRuns: 100` per the task spec.
 */

// ─── Generators ────────────────────────────────────────────────────────────

/** UUID-shaped non-empty token; satisfies the "min 1 char" wire bound. */
const idArb = fc.uuid();

/**
 * Attachment generator. Bytes up to 1 MB raw → base64-encoded inline so
 * the round-trip exercises the same encode path the browser agent uses
 * before the pretty-printer hop. fast-check shrinks toward shorter
 * buffers, so any failure surfaces as a minimal counterexample.
 */
const ONE_MB = 1024 * 1024;
const attachmentArb = fc.record({
  filename: fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.length > 0),
  mimeType: fc.constantFrom('image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain'),
  base64: fc
    .uint8Array({ minLength: 0, maxLength: ONE_MB })
    .map((bytes) => base64Encode(bytes)),
});

const historyMessageArb = fc.record({
  role: fc.constantFrom('user' as const, 'assistant' as const),
  text: fc.string({ maxLength: 256 }),
  createdAt: fc.integer({ min: 0, max: 2_000_000_000_000 }),
});

const expandedTokenArb = fc.record({
  token: fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.length > 0),
  kind: fc.constantFrom('File' as const, 'Folder' as const),
  bytes: fc.integer({ min: 0, max: 200_000 }),
});

const codeContextArb = fc.record(
  {
    selection: fc.string({ maxLength: 256 }),
    filePath: fc.string({ minLength: 1, maxLength: 128 }).filter((s) => s.length > 0),
    language: fc.constantFrom('typescript', 'javascript', 'python', 'rust', 'go'),
    fileContent: fc.string({ maxLength: 1024 }),
    expandedTokens: fc.array(expandedTokenArb, { maxLength: 5 }),
    truncated: fc.record({
      originalSizeBytes: fc.integer({ min: 0, max: 1_000_000 }),
      truncatedToBytes: fc.integer({ min: 0, max: 200_000 }),
    }),
  },
  // Each field is optional on the wire (R13 is "fill what's present"),
  // so generate sparse records to exercise undefined-property dropping
  // by the pretty printer.
  { requiredKeys: [] },
);

const chatRequestArb = fc.record({
  protocolVersion: fc.constant(1 as const),
  requestId: idArb,
  clientId: idArb,
  sessionId: idArb,
  type: fc.constant('chat' as const),
  // Cap at 1024 chars in the default tier — full 32k coverage is left
  // to schema-level validate.test.ts; here we want many shapes, fast.
  prompt: fc.string({ minLength: 1, maxLength: 1024 }).filter((s) => s.length >= 1),
  codeContext: fc.option(codeContextArb, { nil: undefined }),
  history: fc.option(fc.array(historyMessageArb, { maxLength: 8 }), { nil: undefined }),
  attachments: fc.option(fc.array(attachmentArb, { maxLength: 2 }), { nil: undefined }),
  submittedAt: fc.integer({ min: 0, max: 2_000_000_000_000 }),
});

const imageRequestArb = fc.record({
  protocolVersion: fc.constant(1 as const),
  requestId: idArb,
  clientId: idArb,
  sessionId: idArb,
  type: fc.constant('image' as const),
  prompt: fc.string({ minLength: 1, maxLength: 512 }).filter((s) => s.length >= 1),
  codeContext: fc.option(codeContextArb, { nil: undefined }),
  history: fc.option(fc.array(historyMessageArb, { maxLength: 4 }), { nil: undefined }),
  attachments: fc.option(fc.array(attachmentArb, { maxLength: 1 }), { nil: undefined }),
  submittedAt: fc.integer({ min: 0, max: 2_000_000_000_000 }),
});

const requestArb: fc.Arbitrary<Request> = fc.oneof(
  chatRequestArb,
  imageRequestArb,
) as fc.Arbitrary<Request>;

const streamChunkArb: fc.Arbitrary<StreamChunk> = fc.record(
  {
    protocolVersion: fc.constant(1 as const),
    requestId: idArb,
    chunkIndex: fc.integer({ min: 0, max: 1_000_000 }),
    text: fc.string({ maxLength: 1024 }),
    isFinal: fc.boolean(),
    mediaType: fc.constantFrom(
      'image/png' as const,
      'image/jpeg' as const,
      'image/webp' as const,
      'image/gif' as const,
    ),
    base64: fc
      .uint8Array({ minLength: 0, maxLength: ONE_MB })
      .map((bytes) => base64Encode(bytes)),
    status: fc.constantFrom(
      'completed' as const,
      'cancelled' as const,
      'failed' as const,
      'queue_timeout' as const,
    ),
    errorCode: fc.constantFrom(
      'CHATGPT_ERROR' as const,
      'CHAT_TIMEOUT' as const,
      'IMAGE_TIMEOUT' as const,
      'CONTENT_POLICY' as const,
      'INVALID_PROMPT' as const,
      'AGENT_DISCONNECTED' as const,
    ),
    message: fc.string({ maxLength: 256 }),
  },
  { requiredKeys: ['protocolVersion', 'requestId', 'chunkIndex', 'text', 'isFinal'] },
) as fc.Arbitrary<StreamChunk>;

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Drop `undefined`-valued properties recursively. The pretty printer
 * intentionally omits them from output, so the parsed-back value will
 * not contain them either; deep-equality must compare against the same
 * shape.
 */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = stripUndefined(v);
      }
    }
    return out;
  }
  return value;
}

// ─── Property assertions ───────────────────────────────────────────────────

describe('Property 5: pretty-printer round-trip and determinism', () => {
  it('parse(prettyPrint(req)) deep-equals req and prettyPrint is deterministic across structuredClone for Request trees', () => {
    const prop = fc.property(requestArb, (req) => {
      const printed = prettyPrint('Request', req);

      // (a) Round-trip — JSON.parse must reconstruct a structurally
      // equal object. Compare against the undefined-stripped original
      // because the printer drops undefined keys per design.
      const parsed = parsePrettyPrinted<Request>(printed);
      expect(parsed).toEqual(stripUndefined(req));

      // Attachments specifically: compare base64 strings AND decoded
      // bytes so any UTF-16 / surrogate-pair mangling in the JSON hop
      // surfaces as a byte-level mismatch.
      const origAtt = req.attachments ?? [];
      const parsedAtt = parsed.attachments ?? [];
      expect(parsedAtt.length).toBe(origAtt.length);
      for (let i = 0; i < origAtt.length; i++) {
        const a = origAtt[i]!;
        const b = parsedAtt[i]!;
        expect(b.base64).toBe(a.base64);
        expect(Buffer.from(b.base64, 'base64').equals(Buffer.from(a.base64, 'base64'))).toBe(true);
      }

      // (b) Determinism — structuredClone reorders own-property keys on
      // some runtimes; the pretty printer's canonical key order must
      // make the output byte-stable across that reorder.
      const cloned = structuredClone(req);
      const printedClone = prettyPrint('Request', cloned);
      expect(Buffer.from(printed, 'utf8').equals(Buffer.from(printedClone, 'utf8'))).toBe(true);
    });

    fc.assert(prop, { numRuns: 100 });
  });

  it('parse(prettyPrint(chunk)) deep-equals chunk and prettyPrint is deterministic across structuredClone for StreamChunk', () => {
    const prop = fc.property(streamChunkArb, (chunk) => {
      const printed = prettyPrint('StreamChunk', chunk);

      const parsed = parsePrettyPrinted<StreamChunk>(printed);
      expect(parsed).toEqual(stripUndefined(chunk));

      // Image base64 — when present — must survive the hop byte-for-byte.
      if (typeof chunk.base64 === 'string') {
        expect(parsed.base64).toBe(chunk.base64);
        expect(
          Buffer.from(parsed.base64 ?? '', 'base64').equals(
            Buffer.from(chunk.base64, 'base64'),
          ),
        ).toBe(true);
      }

      const cloned = structuredClone(chunk);
      const printedClone = prettyPrint('StreamChunk', cloned);
      expect(Buffer.from(printed, 'utf8').equals(Buffer.from(printedClone, 'utf8'))).toBe(true);
    });

    fc.assert(prop, { numRuns: 100 });
  });
});
