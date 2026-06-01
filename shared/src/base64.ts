/**
 * Pure-Node base64 codec used by the browser-agent (image encode), the relay
 * (image transit), and the extension (decode-and-save). Round-trip safety is
 * guaranteed by Property 15 (`shared/test/base64.property.test.ts`).
 *
 * Implements R10.3 (encode after image extraction), R10.4 (final response
 * shape with base64 payload), R26.4 (image round-trip equality across the
 * pretty-printer hop).
 *
 * Both functions accept and produce types portable to non-Node consumers:
 * input is `Uint8Array` (and therefore also any `Buffer`, since `Buffer`
 * extends `Uint8Array`), and decode output is a fresh `Uint8Array` rather
 * than a `Buffer` so the contract does not leak Node-only types.
 */

/**
 * Standard base64 alphabet character class, including the optional `=`
 * padding suffix. URL-safe variants (`-` and `_`) are intentionally NOT
 * accepted — `base64Encode` only emits the standard alphabet, so admitting
 * URL-safe input would let invalid wire payloads slip through `decode`.
 */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Encode a byte buffer as a standard base64 string (no line breaks, no
 * URL-safe substitutions). Implements R10.3.
 *
 * @param bytes Source bytes. Accepts any `Uint8Array`, including `Buffer`.
 * @returns Standard base64 string suitable for transport in
 *          `StreamChunk.base64` per the wire schema.
 */
export function base64Encode(bytes: Uint8Array): string {
  // Buffer.from(uint8array) wraps the existing memory without copying when
  // the input is already a Buffer, and copies once otherwise — both cases
  // are O(n) and safe for the 25 MB ceiling enforced by R26.1.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "base64"
  );
}

/**
 * Decode a standard base64 string back to a `Uint8Array`. Implements R10.4
 * and R26.4.
 *
 * Whitespace (spaces, tabs, newlines, carriage returns) is stripped before
 * validation, matching common JSON transport tolerances. After whitespace
 * removal, the remaining input MUST consist solely of characters from the
 * standard base64 alphabet (`A-Z`, `a-z`, `0-9`, `+`, `/`) with at most two
 * trailing `=` padding characters and a total length that is a multiple of
 * four. Otherwise, this function throws.
 *
 * @param encoded Standard base64 string. Whitespace is permitted and
 *                ignored.
 * @returns Decoded bytes as a fresh `Uint8Array` (never a `Buffer` view) so
 *          downstream consumers can rely on plain-array semantics.
 * @throws {TypeError} with message `"base64Decode: invalid base64 input"`
 *         when, after whitespace stripping, the input contains any
 *         character outside the standard base64 alphabet, has a length
 *         that is not a multiple of four, or has malformed padding. The
 *         throw is the only signal — `Buffer.from(s, "base64")` would
 *         otherwise silently drop invalid characters and break the
 *         Property 15 round-trip.
 */
export function base64Decode(encoded: string): Uint8Array {
  const stripped = encoded.replace(/\s+/g, "");

  if (stripped.length % 4 !== 0 || !BASE64_RE.test(stripped)) {
    throw new TypeError("base64Decode: invalid base64 input");
  }

  const buf = Buffer.from(stripped, "base64");
  // Copy into a standalone Uint8Array so the result does not share memory
  // with the underlying Buffer pool and is not a `Buffer` instance.
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}
