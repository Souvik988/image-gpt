import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison of two secret strings. Returns `true` iff the
 * strings are byte-equal. Length-mismatch is detected without leaking the
 * presented length: a constant-time pad runs even when lengths differ.
 *
 * Implements R2.1, R2.2, R2.3 (handshake validation) and R2.5 (16..256
 * char enforcement is the caller's job; this primitive only compares).
 */
export function compareSecrets(presented: string, expected: string): boolean {
  // Buffer.from with explicit utf8 normalises encoding both sides.
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  // Run a constant-time pass over a fixed-length buffer regardless of input
  // length. We always compare against `b` and use a scratch buffer of the
  // same length as `b`, copying as much of `a` as fits (or padding with
  // zeros) — but we still XOR the lengths into the result so a
  // length-mismatch always reads as false even if the prefixes happen
  // to match.
  const scratch = Buffer.alloc(b.length);
  a.copy(scratch); // copies min(a.length, scratch.length) bytes; rest stays 0
  const equalBytes = timingSafeEqual(scratch, b);
  const equalLength = a.length === b.length;
  return equalBytes && equalLength;
}
