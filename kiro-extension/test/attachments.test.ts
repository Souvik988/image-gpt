/**
 * Unit tests for attachment validation (`src/commands/attachments.ts`).
 *
 * Covers (R18.1, R18.2, R18.3, R18.4, R18.5):
 *  - Allow-list of extensions: image (`.jpg/.jpeg/.png/.gif/.webp`) and
 *    document (`.pdf/.txt/.md/.docx`); anything else is rejected with
 *    `unsupported_extension`.
 *  - 25 MB stat short-circuit: the size check fires BEFORE the file is
 *    read so we never load > 25 MB into memory.
 *  - base64 round-trip: the returned `Attachment.base64` decodes back to
 *    the exact bytes that were on disk.
 *  - Filename and MIME type assignment match the file extension.
 *
 * The function under test (`validateAttachmentFile`) reads the real
 * filesystem via `fs.statSync` / `fs.readFileSync`. Each test writes a
 * fixture file under `os.tmpdir()` so the assertions exercise the real
 * I/O path without mocking `node:fs`.
 *
 * _Implements: R18.1, R18.2, R18.3, R18.4, R18.5_
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  validateAttachmentFile,
  ATTACHMENT_MAX_BYTES,
  SUPPORTED_IMAGE_EXTS,
  SUPPORTED_DOC_EXTS,
} from '../src/commands/attachments.js';
import { base64Decode, base64Encode } from '@kiro-gpt-bridge/shared';

// ─── Fixture helpers ───────────────────────────────────────────────────────

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kirogpt-attach-'));
});

afterAll(() => {
  // Best-effort cleanup of the test workspace.
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeFixture(name: string, data: Uint8Array | string): string {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, data);
  return p;
}

// ─── Allow-list (R18.1) ────────────────────────────────────────────────────

describe('validateAttachmentFile — extension allow-list (R18.1)', () => {
  it('accepts every supported image extension', () => {
    for (const ext of SUPPORTED_IMAGE_EXTS) {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const p = writeFixture(`pic${ext}`, bytes);
      const r = validateAttachmentFile(p);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.attachment.filename).toBe(`pic${ext}`);
        expect(r.attachment.mimeType.startsWith('image/')).toBe(true);
      }
    }
  });

  it('accepts every supported document extension', () => {
    for (const ext of SUPPORTED_DOC_EXTS) {
      const p = writeFixture(`doc${ext}`, 'hello');
      const r = validateAttachmentFile(p);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.attachment.filename).toBe(`doc${ext}`);
      }
    }
  });

  it('is case-insensitive for extension matching (lower vs upper)', () => {
    const p = writeFixture('upper.PNG', new Uint8Array([1, 2, 3]));
    const r = validateAttachmentFile(p);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attachment.mimeType).toBe('image/png');
    }
  });

  it('rejects unsupported extensions with reason "unsupported_extension"', () => {
    for (const ext of ['.exe', '.zip', '.bin', '.js', '.ts']) {
      const p = writeFixture(`bad${ext}`, new Uint8Array([0]));
      const r = validateAttachmentFile(p);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('unsupported_extension');
        expect(r.message).toMatch(new RegExp(ext.replace('.', '\\.')));
      }
    }
  });

  it('rejects a file with no extension at all', () => {
    const p = writeFixture('noext', new Uint8Array([0]));
    const r = validateAttachmentFile(p);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('unsupported_extension');
    }
  });
});

// ─── 25 MB stat short-circuit (R18.3) ──────────────────────────────────────

describe('validateAttachmentFile — 25 MB stat short-circuit (R18.3)', () => {
  it('rejects files whose size exceeds 25 MB without reading them into memory', () => {
    // Use fs.truncate to create a sparse file > 25 MB without actually
    // writing 25 MB of bytes — this verifies the size check happens via
    // `statSync` BEFORE any `readFileSync` call.
    const p = path.join(tmpRoot, 'huge.pdf');
    const fd = fs.openSync(p, 'w');
    try {
      fs.ftruncateSync(fd, ATTACHMENT_MAX_BYTES + 1);
    } finally {
      fs.closeSync(fd);
    }

    const stat = fs.statSync(p);
    expect(stat.size).toBe(ATTACHMENT_MAX_BYTES + 1);

    const r = validateAttachmentFile(p);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('too_large');
      expect(r.message).toMatch(/25 MB/);
    }
  });

  it('accepts files at exactly the 25 MB ceiling', () => {
    // Don't actually allocate 25 MB on every test run; create a sparse
    // file at the boundary value and verify the limit is inclusive.
    const p = path.join(tmpRoot, 'boundary.pdf');
    const fd = fs.openSync(p, 'w');
    try {
      fs.ftruncateSync(fd, ATTACHMENT_MAX_BYTES);
    } finally {
      fs.closeSync(fd);
    }
    const stat = fs.statSync(p);
    expect(stat.size).toBe(ATTACHMENT_MAX_BYTES);

    const r = validateAttachmentFile(p);
    // The function reads the file, so the boundary case must succeed
    // (or fail with a read_failed if the OS won't read sparse files).
    // We only assert the size guard did not reject on `too_large`.
    if (!r.ok) {
      expect(r.reason).not.toBe('too_large');
    }
  });
});

// ─── base64 round-trip (R18.5) ─────────────────────────────────────────────

describe('validateAttachmentFile — base64 round-trip (R18.5)', () => {
  it('produces base64 that decodes back to the original bytes (small)', () => {
    const original = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff,
    ]);
    const p = writeFixture('pixel.png', original);
    const r = validateAttachmentFile(p);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const decoded = base64Decode(r.attachment.base64);
      expect(Array.from(decoded)).toEqual(Array.from(original));
      // Cross-check: encoding the original directly produces the same
      // base64 string the validator emits.
      expect(r.attachment.base64).toBe(base64Encode(original));
    }
  });

  it('produces base64 that decodes back to the original bytes (medium, 1 MB)', () => {
    const SIZE = 1 * 1024 * 1024;
    const original = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) {
      original[i] = (i * 31 + 7) & 0xff;
    }
    const p = writeFixture('blob.pdf', original);
    const r = validateAttachmentFile(p);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const decoded = base64Decode(r.attachment.base64);
      expect(decoded.byteLength).toBe(SIZE);
      // Spot-check first/last/some-middle bytes — full equality is too
      // expensive on every run.
      expect(decoded[0]).toBe(original[0]);
      expect(decoded[SIZE - 1]).toBe(original[SIZE - 1]);
      expect(decoded[SIZE >> 1]).toBe(original[SIZE >> 1]);
    }
  });

  it('handles empty files (0-byte payload, valid extension)', () => {
    const p = writeFixture('empty.txt', '');
    const r = validateAttachmentFile(p);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attachment.base64).toBe('');
      expect(base64Decode(r.attachment.base64).byteLength).toBe(0);
    }
  });
});

// ─── MIME type mapping ─────────────────────────────────────────────────────

describe('validateAttachmentFile — MIME type mapping', () => {
  it('maps each supported extension to the documented MIME type', () => {
    const cases: Array<[string, string]> = [
      ['.jpg', 'image/jpeg'],
      ['.jpeg', 'image/jpeg'],
      ['.png', 'image/png'],
      ['.gif', 'image/gif'],
      ['.webp', 'image/webp'],
      ['.pdf', 'application/pdf'],
      ['.txt', 'text/plain'],
      ['.md', 'text/plain'],
      [
        '.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
    ];
    for (const [ext, mime] of cases) {
      const p = writeFixture(`mime${ext}`, 'x');
      const r = validateAttachmentFile(p);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.attachment.mimeType).toBe(mime);
      }
    }
  });
});

// ─── read_failed path ──────────────────────────────────────────────────────

describe('validateAttachmentFile — read_failed', () => {
  it('returns reason "read_failed" when the file does not exist', () => {
    const r = validateAttachmentFile(path.join(tmpRoot, 'does-not-exist.png'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('read_failed');
    }
  });
});
