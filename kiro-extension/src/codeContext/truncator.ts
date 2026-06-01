/**
 * `codeContext/truncator.ts` — enforces the R14.4 200 KB ceiling on a
 * resolved Code_Context body.
 *
 * After {@link ../codeContext/resolver | resolver.ts} expands `#File:` /
 * `#Folder:` tokens, the assembled Code_Context can grow large. The
 * transport layer has its own 25 MB cap, but R14.4 prescribes a tighter
 * cooperative 200 KB cap so the model isn't drowned in editor context.
 * If the cap is exceeded, this module truncates the body at a UTF-8
 * code-point boundary and appends an ASCII notice the caller folds into
 * the outgoing prompt.
 *
 * Implements R14.4.
 */

/**
 * Hard cap on the assembled Code_Context size, in UTF-8 bytes
 * (200 KiB exactly == 204_800). When {@link truncateCodeContext}
 * truncates, the returned `text` is exactly this many bytes (notice
 * included).
 */
export const MAX_BYTES = 200 * 1024;

/**
 * Outcome of a {@link truncateCodeContext} call.
 *
 * `originalSizeBytes` and `truncatedToBytes` map directly to the
 * `CodeContext.truncated` schema field on the wire payload, so the
 * caller can persist them for traceability when `truncated === true`.
 */
export interface TruncatorResult {
  /** Possibly-truncated body, with notice appended when truncated. */
  text: string;
  /** True iff the input exceeded {@link MAX_BYTES} and was shortened. */
  truncated: boolean;
  /** UTF-8 byte length of the original input. */
  originalSizeBytes: number;
  /** UTF-8 byte length of the returned `text`. Equals {@link MAX_BYTES} when truncated. */
  truncatedToBytes: number;
}

/**
 * Enforce the R14.4 200 KB ceiling on `text`. Returns a result with the
 * (possibly truncated) text, a flag indicating whether truncation
 * occurred, and metadata fields suitable for the
 * `CodeContext.truncated` schema field.
 *
 * Byte budget is measured in UTF-8 bytes ({@link Buffer.byteLength}),
 * NOT `text.length` (which counts UTF-16 code units). When truncation
 * is required, the function:
 *  1. Truncates the input at the LAST UTF-8 code-point boundary that
 *     fits, so the output is always valid UTF-8 (never a half-character).
 *  2. Appends a single-line ASCII notice
 *     `"\n\n[Code context truncated from <originalKB> KB to 200 KB]"`
 *     where `<originalKB> = Math.ceil(originalSizeBytes / 1024)`.
 *  3. Returns the FINAL byte length, which is exactly {@link MAX_BYTES}
 *     when truncation occurs (the truncated body is shrunk to make room
 *     for the notice within the same 200 KB budget).
 *
 * When the input already fits in {@link MAX_BYTES} the function is a
 * no-op: it returns the original `text` reference with `truncated: false`
 * and `truncatedToBytes === originalSizeBytes`.
 *
 * @param text - Raw code-context body produced by the resolver.
 * @returns A {@link TruncatorResult} with the (possibly truncated) text
 *   and the byte-size metadata for the `CodeContext.truncated` field.
 */
export function truncateCodeContext(text: string): TruncatorResult {
  const originalSizeBytes = Buffer.byteLength(text, 'utf8');
  if (originalSizeBytes <= MAX_BYTES) {
    return {
      text,
      truncated: false,
      originalSizeBytes,
      truncatedToBytes: originalSizeBytes,
    };
  }

  const originalKB = Math.ceil(originalSizeBytes / 1024);
  const notice = `\n\n[Code context truncated from ${originalKB} KB to 200 KB]`;
  const noticeBytes = Buffer.byteLength(notice, 'utf8');
  const bodyBudget = MAX_BYTES - noticeBytes;
  const body = safeUtf8Slice(text, bodyBudget);
  const out = body + notice;

  return {
    text: out,
    truncated: true,
    originalSizeBytes,
    truncatedToBytes: Buffer.byteLength(out, 'utf8'),
  };
}

/**
 * Return a prefix of `text` whose UTF-8 byte length is at most
 * `byteBudget`, without splitting a multi-byte UTF-8 sequence.
 *
 * `String.prototype.slice` operates on UTF-16 code units, and a naive
 * `Buffer.subarray(0, n)` may chop a multi-byte codepoint mid-sequence
 * yielding invalid UTF-8 (decoded as U+FFFD). This helper walks back
 * over any continuation bytes (`10xxxxxx`, i.e. `0x80..0xBF`) so the
 * returned slice ends on a complete codepoint boundary.
 *
 * @param text - Source string to slice.
 * @param byteBudget - Maximum allowed UTF-8 byte length of the result.
 * @returns A prefix of `text` whose UTF-8 byte length is `<= byteBudget`.
 */
function safeUtf8Slice(text: string, byteBudget: number): string {
  if (byteBudget <= 0) return '';
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= byteBudget) return text;
  let end = byteBudget;
  // 0b10xxxxxx (0x80..0xBF) marks a UTF-8 continuation byte; back up to
  // the start of the codepoint so we never emit a half-character.
  while (end > 0) {
    const byte = buf[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end--;
  }
  return buf.subarray(0, end).toString('utf8');
}
