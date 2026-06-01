import * as fs from 'node:fs';
import * as path from 'node:path';
import { base64Encode } from '@kiro-gpt-bridge/shared';
import type { Attachment } from '@kiro-gpt-bridge/shared';

/** Maximum allowed attachment size in bytes (R18.3). */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** Allowed extensions (R18.1). */
export const SUPPORTED_IMAGE_EXTS: readonly string[] = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
export const SUPPORTED_DOC_EXTS: readonly string[] = ['.pdf', '.txt', '.md', '.docx'];

export type AttachmentValidationResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; reason: 'too_large' | 'unsupported_extension' | 'read_failed'; message: string };

/**
 * Validate a candidate attachment file path. Implements R18.1, R18.3, R18.5.
 *
 * Returns a fully-loaded Attachment (including base64 + mimeType) on success,
 * or a discriminated failure on rejection. The size check happens BEFORE the
 * file is read so we don't load > 25 MB into memory.
 */
export function validateAttachmentFile(filePath: string): AttachmentValidationResult {
  const ext = path.extname(filePath).toLowerCase();
  const isImage = SUPPORTED_IMAGE_EXTS.includes(ext);
  const isDoc = SUPPORTED_DOC_EXTS.includes(ext);
  if (!isImage && !isDoc) {
    return {
      ok: false,
      reason: 'unsupported_extension',
      message: `File type ${ext} is not supported. Allowed: ${[...SUPPORTED_IMAGE_EXTS, ...SUPPORTED_DOC_EXTS].join(', ')}`,
    };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    return { ok: false, reason: 'read_failed', message: (e as Error).message };
  }
  if (stat.size > ATTACHMENT_MAX_BYTES) {
    return {
      ok: false,
      reason: 'too_large',
      message: `File size ${stat.size} bytes exceeds 25 MB limit`,
    };
  }
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (e) {
    return { ok: false, reason: 'read_failed', message: (e as Error).message };
  }
  return {
    ok: true,
    attachment: {
      filename: path.basename(filePath),
      mimeType: mimeFromExtension(ext),
      base64: base64Encode(new Uint8Array(buffer)),
    },
  };
}

function mimeFromExtension(ext: string): string {
  switch (ext) {
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.pdf': return 'application/pdf';
    case '.txt': case '.md': return 'text/plain';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    default: return 'application/octet-stream';
  }
}
