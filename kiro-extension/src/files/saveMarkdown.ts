/**
 * @file `files/saveMarkdown.ts` — save a final Response as a markdown file
 * under the workspace root.
 *
 * Implements R19.1 (filename prompt with validation + re-prompt),
 * R19.2 (UTF-8 write + success notification), R19.3 (overwrite confirm
 * with explicit-decline abort), R19.4 (overwrite-dismissed
 * timestamp-suffix fallback `_YYYYMMDD-HHMMSS`), R19.5 (no-workspace
 * abort with error), and R19.6 (atomic write via `.tmp-<random>` →
 * rename, no partial file on failure).
 *
 * The flow is host-injectable: VS Code prompts and `fs` are abstracted
 * behind {@link SaveMarkdownContext} so unit/property tests can drive
 * the logic without touching disk or the editor host.
 */

import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Maximum number of filename re-prompts before we give up. R19.1. */
const MAX_FILENAME_PROMPTS = 3;

/** Default markdown extension auto-appended when the user omits it. R19.1. */
const MD_EXT = '.md';

/** Default filename suggestion when the caller does not supply one. */
const DEFAULT_NAME = 'response';

/** Input to {@link saveMarkdown}. */
export interface SaveMarkdownInput {
  /** Markdown text to save. */
  text: string;
  /** Optional default filename suggestion (without `.md`). */
  defaultName?: string;
}

/**
 * Injectable context for {@link saveMarkdown}: workspace root, host
 * prompts, host notifications, filesystem, and an optional clock for
 * deterministic timestamp suffixing.
 */
export interface SaveMarkdownContext {
  /** Absolute path of the open workspace folder, or `null` if none. R19.5. */
  workspaceRoot: string | null;
  /**
   * Show a filename input box pre-filled with `defaultName`. Returns the
   * user's input, or `undefined` if the user cancelled the prompt.
   */
  promptFilename(defaultName: string): Promise<string | undefined>;
  /**
   * Confirm overwrite for an existing path. Returns:
   * - `'overwrite'` when the user explicitly confirms overwrite,
   * - `'cancel'` when the user explicitly declines (R19.3),
   * - `undefined` when the prompt was dismissed without choosing
   *   (triggers R19.4 timestamp-suffix fallback).
   */
  promptOverwrite(targetPath: string): Promise<'overwrite' | 'cancel' | undefined>;
  /** Display an error to the user. */
  showError(message: string): void;
  /** Display a confirmation message to the user. */
  showInfo(message: string): void;
  /** Filesystem operations used by the save flow. */
  fs: SaveMarkdownFs;
  /** Optional clock injection for deterministic timestamp suffixing. */
  now?: () => Date;
}

/** Subset of `node:fs/promises` the save flow needs. */
export interface SaveMarkdownFs {
  /** Resolve to `true` iff `path` exists. */
  exists(path: string): Promise<boolean>;
  /** Create directory `path` (recursively). */
  mkdir(path: string, opts: { recursive: true }): Promise<void>;
  /** Write `data` to `path` with UTF-8 encoding. */
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  /** Rename `from` to `to`. */
  rename(from: string, to: string): Promise<void>;
  /** Best-effort delete of `path`. May reject if the path is missing. */
  unlink(path: string): Promise<void>;
}

/** Result of {@link saveMarkdown}. */
export type SaveMarkdownResult =
  | { ok: true; savedPath: string }
  | {
      ok: false;
      reason: 'no_workspace' | 'invalid_filename' | 'cancelled' | 'write_failed';
      message?: string;
    };

/**
 * Format a `Date` as `_YYYYMMDD-HHMMSS` using local time. The year is
 * 4 digits; month, day, hour, minute, and second are each zero-padded
 * to 2 digits. R19.4.
 *
 * @example
 *   timestampSuffix(new Date(2024, 0, 31, 14, 30, 25)) === '_20240131-143025';
 */
export function timestampSuffix(date: Date): string {
  const yyyy = String(date.getFullYear()).padStart(4, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `_${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

/**
 * Windows reserved device names (case-insensitive). Apply to the
 * basename — i.e. the portion before the extension. R19.1.
 */
const WIN_RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/** Characters never permitted in a filename on Windows or POSIX. R19.1. */
const ILLEGAL_CHARS_RE = /[<>:"/\\|?*\x00-\x1f\x7f]/;

/**
 * True iff `name` is a syntactically valid filename for the host
 * filesystem. Rules (R19.1):
 *
 * - Length is between 1 and 255 inclusive.
 * - Contains no characters illegal on Windows or POSIX:
 *   `< > : " / \ | ? *`, NUL, control chars (`\x01`–`\x1f`), and DEL.
 * - Does not end in `.` or space (Windows).
 * - Basename (portion before the final extension) is not a Windows
 *   reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`,
 *   `LPT1`–`LPT9`), case-insensitive.
 *
 * Pure helper — no I/O.
 */
export function isValidFilename(name: string): boolean {
  if (typeof name !== 'string') {
    return false;
  }
  if (name.length < 1 || name.length > 255) {
    return false;
  }
  if (ILLEGAL_CHARS_RE.test(name)) {
    return false;
  }
  // Windows: a trailing dot or space is silently stripped by the OS,
  // which makes "foo." and "foo " collide with "foo". Reject upfront.
  const last = name.charAt(name.length - 1);
  if (last === '.' || last === ' ') {
    return false;
  }
  // Reserved device-name check applies to the stem (before the last `.`).
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  if (WIN_RESERVED_RE.test(stem)) {
    return false;
  }
  return true;
}

/**
 * Append `.md` to `name` if it does not already end with `.md`
 * (case-insensitive). Mirrors the user's "default extension" expectation
 * from R19.1.
 */
function ensureMdExtension(name: string): string {
  return name.toLowerCase().endsWith(MD_EXT) ? name : `${name}${MD_EXT}`;
}

/**
 * Save markdown text to a user-chosen path under the workspace root.
 *
 * Behavior summary:
 *
 * - R19.5: if no workspace folder is open, shows an error and returns
 *   `{ ok: false, reason: 'no_workspace' }` without writing.
 * - R19.1: prompts for a filename, auto-appends `.md` if missing, and
 *   re-prompts up to {@link MAX_FILENAME_PROMPTS} times on invalid
 *   input. If the user cancels the prompt, returns
 *   `{ ok: false, reason: 'cancelled' }`. If validation never succeeds,
 *   returns `{ ok: false, reason: 'invalid_filename' }`.
 * - R19.3: if the chosen path exists, calls `promptOverwrite`. On
 *   `'cancel'`, aborts without modifying the file.
 * - R19.4: on `undefined` (dismissed without choosing), appends a
 *   `_YYYYMMDD-HHMMSS` suffix before `.md` and writes to that
 *   uniquely-named path.
 * - R19.6: writes atomically by writing to `<target>.tmp-<random>`
 *   and renaming. On any error, best-effort `unlink` of the tmp file
 *   so no partial file remains, and returns
 *   `{ ok: false, reason: 'write_failed', message }`.
 * - R19.2: on success, calls `showInfo("Saved <path>")` and returns
 *   `{ ok: true, savedPath }`.
 *
 * Implements R19.1, R19.2, R19.3, R19.4, R19.5, R19.6.
 */
export async function saveMarkdown(
  input: SaveMarkdownInput,
  ctx: SaveMarkdownContext,
): Promise<SaveMarkdownResult> {
  // R19.5 — no workspace folder open.
  if (ctx.workspaceRoot === null || ctx.workspaceRoot.length === 0) {
    ctx.showError('Cannot save: no workspace folder is open.');
    return { ok: false, reason: 'no_workspace' };
  }

  // R19.1 — prompt + validate + re-prompt.
  const defaultName = input.defaultName ?? DEFAULT_NAME;
  let filename: string | undefined;
  for (let attempt = 0; attempt < MAX_FILENAME_PROMPTS; attempt += 1) {
    const raw = await ctx.promptFilename(defaultName);
    if (raw === undefined) {
      return { ok: false, reason: 'cancelled' };
    }
    const candidate = ensureMdExtension(raw);
    if (isValidFilename(candidate)) {
      filename = candidate;
      break;
    }
    ctx.showError(
      `Invalid filename "${raw}". Filenames must be 1–255 characters and must ` +
        'not contain <>:"/\\|?* or reserved names.',
    );
  }
  if (filename === undefined) {
    return { ok: false, reason: 'invalid_filename' };
  }

  const workspaceRoot = ctx.workspaceRoot;
  const targetPath = path.join(workspaceRoot, filename);

  // R19.3 / R19.4 — overwrite handling.
  let writePath = targetPath;
  if (await ctx.fs.exists(targetPath)) {
    const choice = await ctx.promptOverwrite(targetPath);
    if (choice === 'cancel') {
      return { ok: false, reason: 'cancelled' };
    }
    if (choice === undefined) {
      // R19.4 — dismissed without choosing: append timestamp suffix
      // before the `.md` extension and write to that unique path.
      const clock = ctx.now ?? (() => new Date());
      const suffix = timestampSuffix(clock());
      const ext = path.extname(filename);
      const stem = filename.slice(0, filename.length - ext.length);
      writePath = path.join(workspaceRoot, `${stem}${suffix}${ext}`);
    }
    // 'overwrite' — keep writePath = targetPath.
  }

  // R19.6 — atomic write: tmp file → rename. On any error, best-effort
  // unlink so we never leave a partial file at the target path.
  const tmpPath = `${writePath}.tmp-${randomBytes(8).toString('hex')}`;
  try {
    await ctx.fs.mkdir(path.dirname(writePath), { recursive: true });
    await ctx.fs.writeFile(tmpPath, input.text, 'utf8');
    await ctx.fs.rename(tmpPath, writePath);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    try {
      await ctx.fs.unlink(tmpPath);
    } catch {
      // Best-effort cleanup; ignore unlink errors (the tmp may not
      // have been created, or may already be gone).
    }
    ctx.showError(`Failed to save: ${message}`);
    return { ok: false, reason: 'write_failed', message };
  }

  // R19.2 — success notification.
  ctx.showInfo(`Saved ${writePath}`);
  return { ok: true, savedPath: writePath };
}
