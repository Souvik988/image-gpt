// Feature: kiro-gpt-bridge, Property 15: base64Decode(base64Encode(b)) === b for all byte buffers up to 25 MB
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { base64Encode, base64Decode } from '../src/base64.js';

/**
 * Property 15 — image base64 round-trip. Validates Requirements 10.3, 10.4,
 * and 26.4 (the wire-level guarantee that bytes encoded by the browser
 * agent are reconstructed byte-for-byte by the extension after riding
 * through Socket.IO and the deterministic pretty-printer hop).
 *
 * Default-tier test: byte buffers up to 1 MB at numRuns: 200. The slow-tier
 * companion (`base64.slow.test.ts`, gated by `vitest.config.slow.ts`)
 * exercises the full 25 MB ceiling at numRuns: 5.
 */
describe('Property 15: base64 round-trip', () => {
  it('base64Decode(base64Encode(b)) === b for arbitrary byte buffers up to 1 MB', () => {
    const ONE_MB = 1024 * 1024;

    const prop = fc.property(
      // Length 0..1 MB. fast-check's uint8Array generator already shrinks
      // toward small lengths and toward zero bytes, so failures surface
      // as minimal counterexamples without extra tuning.
      fc.uint8Array({ minLength: 0, maxLength: ONE_MB }),
      (bytes) => {
        const encoded = base64Encode(bytes);

        // Encoded form must use only the standard alphabet (no URL-safe
        // chars, no whitespace, no line breaks). Any deviation would
        // silently break the extension's strict decoder.
        expect(encoded).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
        expect(encoded.length % 4).toBe(0);

        const decoded = base64Decode(encoded);

        // Byte-equality on length first (cheap fail signal), then on
        // contents. Comparing as Buffers gives us O(n) memcmp.
        expect(decoded.byteLength).toBe(bytes.byteLength);
        expect(Buffer.from(decoded).equals(Buffer.from(bytes))).toBe(true);
      },
    );

    fc.assert(prop, { numRuns: 200 });
  });

  it('handles the empty buffer as the identity round-trip', () => {
    // Boundary case fast-check usually finds, asserted explicitly so
    // regressions are obvious in the unit-output column.
    const empty = new Uint8Array(0);
    expect(base64Encode(empty)).toBe('');
    expect(base64Decode('').byteLength).toBe(0);
  });
});
