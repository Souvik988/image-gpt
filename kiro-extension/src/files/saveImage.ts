/**
 * @file Image save flow for the KIRO Extension panel.
 *
 * Implements R17.4 (image render-and-save action), R17.5 (filename prompt
 * with default extension matching the MIME type, length 1–255, write under
 * workspace root), R17.6 (per-host filename validation with re-prompt on
 * failure), R17.7 (overwrite confirmation; abort on decline), R17.8
 * (workspace-required guard with error and abort), and R17.9 (when the
 * Response carries an error code instead of image data, the Save action
 * MUST NOT proceed).
 *
 * The file is structured as a pure controller plus three pure helpers
 * (`deriveExtension`, `isValidFilename`, `slugifyDefaultName`). All host
 * side-effects (filesystem, prompts, messages) are passed in via
 * {@link SaveImageContext} so the unit tests in task 19.11 can drive the
 * flow with in-memory fakes — no `vscode` import here.
 *
 * Design references: design.md → "Components and Interfaces" →
 * "files/saveMarkdown.ts / files/saveImage.ts".
 */

import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import { base64Decode, type ErrorCode } from '@kiro-gpt-bridge/shared';

// ─── Public types ──────────────────────────────────────────────────────────

/** Image MIME types accepted by R17.4. */
export type SaveImageMimeType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif';

/** Input payload describing the image to save. */
export interface SaveImageInput {
  /** Image MIME type — image/png|jpeg|webp|gif. */
  mimeType: SaveImageMimeType;
  /** base64 payload. */
  base64: string;
  /** Optional pre-filled default filename (no extension required). */
  defaultName?: string;
  /**
   * Optional pre-supplied error code. Per R17.9, when the upstream Response
   * carries an error code instead of image data, the panel MUST NOT show
   * the "Save to workspace" action — but if a caller invokes saveImage
   * anyway, this guard returns `should_not_save` rather than writing.
   */
  errorCode?: ErrorCode;
}

/** Filesystem subset injected for testability — see design.md §"saveImage". */
export interface SaveImageFs {
  /** True iff a node (file or directory) exists at `path`. */
  exists(path: string): Promise<boolean>;
  /** Recursively create a directory, no-op if it exists. */
  mkdir(path: string, opts: { recursive: true }): Promise<void>;
  /** Write `data` to `path`, replacing any existing file. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Atomically rename `from` → `to`. */
  rename(from: string, to: string): Promise<void>;
  /** Delete `path`; best-effort, may reject if absent. */
  unlink(path: string): Promise<void>;
}

/** Host bindings for the save flow (filesystem, prompts, messages). */
export interface SaveImageContext {
  /** Workspace root absolute path, or null if no workspace open. */
  workspaceRoot: string | null;
  /** Prompt for filename. Production binds to `vscode.window.showInputBox`. */
  promptFilename(defaultName: string): Promise<string | undefined>;
  /** Prompt for overwrite confirmation. */
  promptOverwrite(
    targetPath: string,
  ): Promise<'overwrite' | 'cancel' | undefined>;
  /** Show an error message to the user. */
  showError(message: string): void;
  /** Show an info message to the user. */
  showInfo(message: string): void;
  /** Abstract fs subset for testing. */
  fs: SaveImageFs;
}

/** Outcome of the save flow. */
export type SaveImageResult =
  | { ok: true; savedPath: string }
  | {
      ok: false;
      reason:
        | 'no_workspace'
        | 'invalid_filename'
        | 'cancelled'
        | 'should_not_save'
        | 'write_failed';
      message?: string;
    };

// ─── Constants ─────────────────────────────────────────────────────────────

/** Minimum filename length per R17.5. */
const MIN_FILENAME_LEN = 1;
/** Maximum filename length per R17.5 (host filesystem ceiling). */
const MAX_FILENAME_LEN = 255;
/** Maximum number of invalid-filename re-prompts before giving up (R17.6). */
const MAX_FILENAME_ATTEMPTS = 3;

/**
 * Characters forbidden in either Windows or POSIX filenames. The set is the
 * union of Windows-reserved (`<>:"/\|?*`) and the cross-platform
 * path-separators (`/`, `\`). Control characters 0x00–0x1F are rejected
 * separately so the regex stays printable.
 */
const FORBIDDEN_CHAR_RE = /[<>:"/\\|?*]/;

/**
 * Windows reserved device names. A filename matches if its base (without
 * extension) — uppercased — exactly equals one of these.
 */
const WINDOWS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

// ─── Pure helpers ──────────────────────────────────────────────────────────

/**
 * Map an image MIME type to its conventional file extension.
 *
 * `image/jpeg` maps to `.jpg` (the canonical short form) per R17.5.
 *
 * Implements R17.5.
 */
export function deriveExtension(
  mime: SaveImageMimeType,
): '.png' | '.jpg' | '.webp' | '.gif' {
  switch (mime) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
  }
}

/**
 * Validate a filename for the host filesystem, taking the strict
 * intersection of Windows and POSIX rules so a name accepted here is
 * portable to both. Implements R17.6.
 *
 * Rejection rules:
 *  - Length outside `[1, 255]`.
 *  - Contains any of `< > : " / \ | ? *`.
 *  - Contains any control character in the range `0x00–0x1F`.
 *  - Base name (without extension), uppercased, equals a Windows
 *    reserved device name (CON, PRN, AUX, NUL, COM1..9, LPT1..9).
 *  - Trailing space or trailing `.` (Windows trims silently, which loses
 *    the user's intended filename).
 */
export function isValidFilename(name: string): boolean {
  if (typeof name !== 'string') {
    return false;
  }
  if (name.length < MIN_FILENAME_LEN || name.length > MAX_FILENAME_LEN) {
    return false;
  }
  if (FORBIDDEN_CHAR_RE.test(name)) {
    return false;
  }
  // Reject control chars 0x00–0x1F. We check char-by-char to keep the
  // forbidden-printable-char regex above readable.
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code <= 0x1f) {
      return false;
    }
  }
  // Windows trims trailing whitespace and dots from filenames silently;
  // reject them here so the saved file's name matches what the user typed.
  const last = name.charAt(name.length - 1);
  if (last === ' ' || last === '.') {
    return false;
  }
  // Windows reserved device names: match against the base name only,
  // uppercased, with or without an extension.
  const dotIdx = name.indexOf('.');
  const base = dotIdx === -1 ? name : name.slice(0, dotIdx);
  if (WINDOWS_RESERVED_NAMES.has(base.toUpperCase())) {
    return false;
  }
  return true;
}

/**
 * Slugify a free-form default name into something safe to seed the
 * filename prompt with: lowercase, alphanumerics and hyphens only, no
 * leading/trailing hyphens, length ≤ 64. Returns an empty string when
 * nothing slug-worthy remains so the caller can fall back to a
 * timestamp-based default.
 */
function slugifyDefaultName(raw: string): string {
  const lower = raw.toLowerCase();
  // Replace any run of non-[a-z0-9] characters with a single hyphen.
  const replaced = lower.replace(/[^a-z0-9]+/g, '-');
  // Trim leading/trailing hyphens and clamp length.
  const trimmed = replaced.replace(/^-+|-+$/g, '');
  return trimmed.slice(0, 64);
}

/** Build a `image-YYYYMMDD-HHMMSS` style fallback name. */
function timestampDefaultName(now: Date): string {
  const yyyy = now.getFullYear().toString().padStart(4, '0');
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  const dd = now.getDate().toString().padStart(2, '0');
  const hh = now.getHours().toString().padStart(2, '0');
  const mi = now.getMinutes().toString().padStart(2, '0');
  const ss = now.getSeconds().toString().padStart(2, '0');
  return `image-${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

/**
 * If `name` does not already end with `ext` (case-insensitively), append
 * `ext`. Used to honor the MIME-type-derived extension regardless of what
 * the user typed.
 */
function ensureExtension(name: string, ext: string): string {
  if (name.toLowerCase().endsWith(ext.toLowerCase())) {
    return name;
  }
  return name + ext;
}

// ─── Main entry point ──────────────────────────────────────────────────────

/**
 * Save an image (base64) to a user-chosen path under the workspace root.
 *
 * Flow:
 *  1. R17.9 short-circuit when the response carried an error code.
 *  2. R17.8 short-circuit when no workspace is open.
 *  3. R17.5 prompt for filename (default seeded from `defaultName` slug
 *     plus the MIME-derived extension, or a timestamped fallback).
 *  4. R17.6 validate filename; re-prompt up to {@link MAX_FILENAME_ATTEMPTS}
 *     times before failing.
 *  5. Auto-append the MIME-derived extension if the user dropped it.
 *  6. R17.7 prompt for overwrite confirmation if the target exists.
 *  7. Atomic write: `writeFile(targetPath + .tmp-XXXX)` then `rename` to
 *     `targetPath`. On any error, best-effort `unlink(tmp)` and return
 *     `write_failed`. Implements R19.6 (no partial files left behind).
 *  8. Success: show info message and return `{ ok: true, savedPath }`.
 *
 * Implements R17.4–R17.9.
 */
export async function saveImage(
  input: SaveImageInput,
  ctx: SaveImageContext,
): Promise<SaveImageResult> {
  // 1. R17.9 — should not save when the response carried an error code.
  if (input.errorCode !== undefined) {
    return { ok: false, reason: 'should_not_save' };
  }

  // 2. R17.8 — workspace required.
  if (ctx.workspaceRoot === null) {
    ctx.showError(
      'No workspace folder is open. Open a folder before saving images.',
    );
    return { ok: false, reason: 'no_workspace' };
  }

  const ext = deriveExtension(input.mimeType);

  // 3. Build the default name shown in the input box.
  const slug = input.defaultName ? slugifyDefaultName(input.defaultName) : '';
  const baseDefault = slug.length > 0 ? slug : timestampDefaultName(new Date());
  const defaultWithExt = baseDefault + ext;

  // 4. Filename prompt + validation, up to MAX_FILENAME_ATTEMPTS.
  let validatedName: string | undefined;
  for (let attempt = 0; attempt < MAX_FILENAME_ATTEMPTS; attempt++) {
    const promptDefault = attempt === 0 ? defaultWithExt : defaultWithExt;
    const typed = await ctx.promptFilename(promptDefault);
    if (typed === undefined) {
      return { ok: false, reason: 'cancelled' };
    }
    // 5. Auto-append extension before validating, so users who type "logo"
    // don't get rejected for the wrong reason.
    const candidate = ensureExtension(typed, ext);
    if (isValidFilename(candidate)) {
      validatedName = candidate;
      break;
    }
    ctx.showError(
      'Invalid filename. Avoid characters < > : " / \\ | ? * and reserved ' +
        'device names (CON, PRN, AUX, NUL, COM1–9, LPT1–9). Length must be ' +
        '1–255.',
    );
  }
  if (validatedName === undefined) {
    return { ok: false, reason: 'invalid_filename' };
  }

  const targetPath = path.join(ctx.workspaceRoot, validatedName);

  // 6. R17.7 — overwrite confirmation.
  let exists = false;
  try {
    exists = await ctx.fs.exists(targetPath);
  } catch (e) {
    return {
      ok: false,
      reason: 'write_failed',
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (exists) {
    const choice = await ctx.promptOverwrite(targetPath);
    if (choice !== 'overwrite') {
      return { ok: false, reason: 'cancelled' };
    }
  }

  // 7. Atomic write: decode → write tmp → rename.
  let bytes: Uint8Array;
  try {
    bytes = base64Decode(input.base64);
  } catch (e) {
    return {
      ok: false,
      reason: 'write_failed',
      message: e instanceof Error ? e.message : String(e),
    };
  }

  const tmpPath = `${targetPath}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await ctx.fs.mkdir(path.dirname(targetPath), { recursive: true });
    await ctx.fs.writeFile(tmpPath, bytes);
    await ctx.fs.rename(tmpPath, targetPath);
  } catch (e) {
    // Best-effort cleanup so a partial .tmp does not survive (R19.6).
    try {
      await ctx.fs.unlink(tmpPath);
    } catch {
      // Intentional: best-effort cleanup, ignore secondary failures.
    }
    const message = e instanceof Error ? e.message : String(e);
    ctx.showError(`Failed to save image: ${message}`);
    return { ok: false, reason: 'write_failed', message };
  }

  // 8. Success.
  ctx.showInfo(`Saved ${targetPath}`);
  return { ok: true, savedPath: targetPath };
}
