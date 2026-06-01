/**
 * @file `#File:` / `#Folder:` token resolver for KIRO Extension prompts.
 *
 * Implements R14.1 (per-file 200 KB cap, content fenced into the prompt),
 * R14.2 (per-folder 1000-file cap, listing of relative POSIX paths), and
 * R14.3 (errors are collected per token; the caller MUST refuse to send
 * the request if any errors are returned). Truncation of the assembled
 * Code_Context (R14.4) is handled by `codeContext/truncator.ts`, NOT here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Reason a `#File:` or `#Folder:` token failed to resolve. Per R14.3, any
 * non-empty errors list MUST cause the caller to refuse to send the
 * Request and to surface a panel error message.
 */
export type ResolveErrorReason =
  | 'outside_workspace'
  | 'not_found'
  | 'file_too_large'
  | 'folder_too_many_files'
  | 'not_a_file'
  | 'not_a_folder'
  | 'read_failed';

/** A single failed token, kept alongside the original token text. */
export interface ResolveError {
  /** Original token text, e.g. `"#File:src/foo.ts"`. */
  token: string;
  /** Machine-readable failure reason, per R14.3. */
  reason: ResolveErrorReason;
  /** Optional details — e.g. a filesystem error message. Never user-input. */
  detail?: string;
}

/** Per-token expansion record, mirroring `CodeContext.expandedTokens` on the wire. */
export interface ResolveExpandedToken {
  token: string;
  kind: 'File' | 'Folder';
  bytes: number;
}

/** Result of resolving a prompt's tokens. */
export interface ResolveResult {
  /** Prompt with all valid `#File:` / `#Folder:` tokens replaced; failed tokens left verbatim. */
  text: string;
  /** Errors collected per offending token. When non-empty, caller MUST NOT send the request (R14.3). */
  errors: ResolveError[];
  /** Per-token expansion records, mirroring `CodeContext.expandedTokens` on the wire. */
  expandedTokens: ResolveExpandedToken[];
}

/**
 * Subset of `node:fs` the resolver needs. Injectable so property-based
 * tests can drive a virtual filesystem without touching disk.
 */
export interface ResolverFs {
  existsSync(p: string): boolean;
  statSync(p: string): { isFile(): boolean; isDirectory(): boolean; size: number };
  readFileSync(p: string, enc: 'utf8'): string;
  readdirSync(
    p: string,
    opts: { withFileTypes: true },
  ): Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
}

/** Default fs implementation backed by `node:fs`. */
const defaultFs: ResolverFs = {
  existsSync: (p) => fs.existsSync(p),
  statSync: (p) => fs.statSync(p),
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  readdirSync: (p, opts) => fs.readdirSync(p, opts),
};

/** Per-file cap, R14.1: 200 KB. */
const FILE_MAX_BYTES = 200 * 1024;

/** Per-folder cap, R14.2: 1000 files. */
const FOLDER_MAX_FILES = 1000;

/**
 * Token regex. A token is `#File:` or `#Folder:` followed by a
 * non-whitespace path. Multiple tokens per prompt are supported.
 */
const TOKEN_RE = /(#File|#Folder):([^\s]+)/g;

/** Convert a host-native path to POSIX form (`/`-separated) for stable output. */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * True iff `abs` lies inside (or at) `root`. Relies on `path.relative`:
 * a path that escapes `root` produces a relative path starting with `..`,
 * and an unrelated absolute path stays absolute.
 */
function isInsideWorkspace(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  if (rel === '') {
    return true;
  }
  if (rel.startsWith('..')) {
    return false;
  }
  if (path.isAbsolute(rel)) {
    return false;
  }
  return true;
}

/**
 * BFS-walk a folder collecting workspace-relative POSIX file paths.
 * Returns `'too_many'` as soon as the (1000 + 1)-th file would be
 * collected; returns the sorted file list otherwise. Implements R14.2.
 */
function walkFolder(
  folderAbs: string,
  workspaceRoot: string,
  fsImpl: ResolverFs,
): string[] | 'too_many' {
  const files: string[] = [];
  const queue: string[] = [folderAbs];

  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Skip unreadable subdirectories: a single bad child must not poison
      // the whole listing. The folder root itself was already validated by
      // the caller via existsSync + statSync.
      continue;
    }

    // Sort children by name within each directory for stable BFS order.
    // We also sort the full list at the end, but sorting here keeps the
    // 1001-st-element cutoff deterministic across platforms.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const childAbs = path.join(dir, entry.name);
      if (entry.isFile()) {
        files.push(toPosix(path.relative(workspaceRoot, childAbs)));
        if (files.length > FOLDER_MAX_FILES) {
          return 'too_many';
        }
      } else if (entry.isDirectory()) {
        queue.push(childAbs);
      }
      // Other entry kinds (symlinks, sockets, devices) are intentionally
      // skipped: R14.2 specifies a "listing of file paths" only.
    }
  }

  files.sort();
  return files;
}

/**
 * Resolve `#File:<path>` and `#Folder:<path>` tokens in `text` against
 * the given workspace root. Implements R14.1, R14.2, and R14.3.
 *
 * - `#File:` tokens are replaced by the file content fenced inside a
 *   language-tag-less ``` block.
 * - `#Folder:` tokens are replaced by a deterministic newline-joined
 *   list of workspace-relative POSIX file paths.
 * - Any token that fails workspace-bounds, not-found, wrong-kind,
 *   per-file-size, per-folder-count, or read checks is left verbatim
 *   in the output text and recorded in `errors`. Such tokens do NOT
 *   appear in `expandedTokens`.
 *
 * Pure / synchronous: uses blocking `fs` calls. The resolver runs
 * inside the extension host where this one-shot user action is safe.
 *
 * @param text          Prompt text potentially containing tokens.
 * @param workspaceRoot Absolute path of the workspace root.
 * @param fsImpl        Optional FS implementation (used by tests).
 */
export function resolveCodeContext(
  text: string,
  workspaceRoot: string,
  fsImpl: ResolverFs = defaultFs,
): ResolveResult {
  const errors: ResolveError[] = [];
  const expandedTokens: ResolveExpandedToken[] = [];

  const out = text.replace(TOKEN_RE, (raw, kindRaw: string, rel: string) => {
    // The regex captures the leading '#' as part of group 1, so kindRaw is
    // either '#File' or '#Folder'. Strip the marker for the kind tag.
    const kind: 'File' | 'Folder' = kindRaw === '#File' ? 'File' : 'Folder';
    const abs = path.resolve(workspaceRoot, rel);

    if (!isInsideWorkspace(workspaceRoot, abs)) {
      errors.push({ token: raw, reason: 'outside_workspace' });
      return raw;
    }

    if (!fsImpl.existsSync(abs)) {
      errors.push({ token: raw, reason: 'not_found' });
      return raw;
    }

    let stat: { isFile(): boolean; isDirectory(): boolean; size: number };
    try {
      stat = fsImpl.statSync(abs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ token: raw, reason: 'read_failed', detail: msg });
      return raw;
    }

    if (kind === 'File') {
      if (!stat.isFile()) {
        errors.push({ token: raw, reason: 'not_a_file' });
        return raw;
      }
      if (stat.size > FILE_MAX_BYTES) {
        errors.push({ token: raw, reason: 'file_too_large' });
        return raw;
      }
      let content: string;
      try {
        content = fsImpl.readFileSync(abs, 'utf8');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ token: raw, reason: 'read_failed', detail: msg });
        return raw;
      }
      const replacement = '```\n' + content + '\n```';
      expandedTokens.push({
        token: raw,
        kind: 'File',
        bytes: Buffer.byteLength(content, 'utf8'),
      });
      return replacement;
    }

    // kind === 'Folder'
    if (!stat.isDirectory()) {
      errors.push({ token: raw, reason: 'not_a_folder' });
      return raw;
    }
    const list = walkFolder(abs, workspaceRoot, fsImpl);
    if (list === 'too_many') {
      errors.push({ token: raw, reason: 'folder_too_many_files' });
      return raw;
    }
    const replacement = list.join('\n');
    expandedTokens.push({
      token: raw,
      kind: 'Folder',
      bytes: Buffer.byteLength(replacement, 'utf8'),
    });
    return replacement;
  });

  return { text: out, errors, expandedTokens };
}
