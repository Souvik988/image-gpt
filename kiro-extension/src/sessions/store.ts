/**
 * On-disk session store with an in-memory cache, atomic file writes, and
 * a bounded retry policy on transient I/O failure.
 *
 * Layout: one JSON file per {@link Session} at
 * `<storageDir>/<sessionId>.json`, serialised through the deterministic
 * {@link prettyPrint} so the byte content is stable for any structurally
 * equal {@link Session} value (R26.2 carryover).
 *
 * Behaviour at a glance:
 *  - `init()` creates the storage directory and reads every existing
 *    `*.json` file into the cache, skipping malformed files with a
 *    structured `session_load_failed` warning to stderr (R15.6, R15.7
 *    — load existing sessions on demand without aborting).
 *  - `save()` updates the in-memory cache *first* (R15.8 retention),
 *    then writes the file using a write-then-rename atomic algorithm
 *    (R19.6, no partial files visible to readers). On disk failure we
 *    retry up to 3 times with `200 ms × n` backoff. After three
 *    consecutive failures the cache is preserved, the
 *    {@link StoreOptions.onPersistFailure} hook is invoked for the
 *    user-facing toast (R15.8), and the next `save()` retries.
 *  - `delete()` removes both the cache entry and the file. ENOENT on
 *    unlink is tolerated since the file may already have been removed.
 *
 * Implements R15.1 (one Session per file under the configured directory),
 * R15.2 (persist message-history additions to disk within 2 s of the
 * `save()` call — three retry attempts complete in ≪ 2 s on any
 * working filesystem), R15.5 / R15.6 / R15.7 (CRUD over the cache),
 * R15.8 (in-memory retention with retry on persistence failure),
 * R19.6 (atomic write — readers never observe a partial file).
 */

import { promises as nodeFs } from 'node:fs';
import * as nodePath from 'node:path';
import type { Session, SessionId } from '@kiro-gpt-bridge/shared';
import { parsePrettyPrinted, prettyPrint } from '@kiro-gpt-bridge/shared';

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * Filesystem subset used by {@link SessionStore}. Inject a stub in tests
 * (or for property-based fault injection) to drive each branch of the
 * retry policy without touching a real disk.
 */
export interface StoreFs {
  /** Create `path` and any missing parents. Idempotent. */
  mkdir(path: string, opts: { recursive: true }): Promise<void>;
  /** Write `data` to `path`, replacing any existing content. */
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  /** Atomically rename `from` to `to`; same-volume on every OS we run on. */
  rename(from: string, to: string): Promise<void>;
  /** Remove `path`. Should reject with `code === 'ENOENT'` if absent. */
  unlink(path: string): Promise<void>;
  /** List entries in `path` as filenames. */
  readdir(path: string): Promise<string[]>;
  /** Read `path` as UTF-8 text. */
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  /** Optional fsync hook. Not currently invoked, kept for future durability work. */
  fsync?(fd: number): Promise<void>;
  /** Optional open hook. Not currently invoked, kept for future durability work. */
  open?(path: string, flags: string): Promise<{ fd: number; close(): Promise<void> }>;
}

/** Construction options for {@link SessionStore}. */
export interface StoreOptions {
  /** Absolute directory under which `<sessionId>.json` files are written. */
  storageDir: string;
  /** Optional fs subset for tests. Defaults to `node:fs/promises`. */
  fs?: StoreFs;
  /**
   * Notification hook invoked when persistence fails after all three
   * retry attempts. The cache is still retained — the next call to
   * {@link SessionStore.save} retries the write. This is the hook the
   * extension uses to surface the user-facing toast in R15.8.
   */
  onPersistFailure?: (sessionId: SessionId, error: Error) => void;
  /** Clock for testability. Defaults to {@link Date.now}. */
  now?: () => number;
}

// ─── Constants ────────────────────────────────────────────────────────────

/** File suffix for persisted sessions. */
const SESSION_EXT = '.json';
/** Marker placed in temp filenames so `init()` can skip them. */
const TMP_MARKER = '.tmp-';
/** Maximum number of write attempts (initial + 2 retries). */
const MAX_ATTEMPTS = 3;
/** Backoff base in milliseconds (multiplied by attempt number). */
const RETRY_BACKOFF_MS = 200;

// ─── Default fs adapter ───────────────────────────────────────────────────

/**
 * Adapt `node:fs/promises` to the {@link StoreFs} shape. Wraps `mkdir`
 * to discard the optional `string | undefined` return so the adapter is
 * structurally compatible with `Promise<void>`.
 */
function createDefaultFs(): StoreFs {
  return {
    mkdir: async (p, opts) => {
      await nodeFs.mkdir(p, opts);
    },
    writeFile: (p, data, encoding) => nodeFs.writeFile(p, data, encoding),
    rename: (from, to) => nodeFs.rename(from, to),
    unlink: (p) => nodeFs.unlink(p),
    readdir: (p) => nodeFs.readdir(p),
    readFile: (p, encoding) => nodeFs.readFile(p, encoding),
  };
}

// ─── Implementation ───────────────────────────────────────────────────────

/**
 * Persistent {@link Session} store backed by one JSON file per session.
 *
 * Implements R15.1, R15.2, R15.5, R15.6, R15.7, R15.8, R19.6.
 */
export class SessionStore {
  private readonly storageDir: string;
  private readonly fs: StoreFs;
  private readonly onPersistFailure: ((sessionId: SessionId, error: Error) => void) | undefined;
  private readonly now: () => number;
  private readonly cache = new Map<SessionId, Session>();
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;

  /** @param opts See {@link StoreOptions}. */
  public constructor(opts: StoreOptions) {
    this.storageDir = opts.storageDir;
    this.fs = opts.fs ?? createDefaultFs();
    this.onPersistFailure = opts.onPersistFailure;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Ensure the storage directory exists and load every existing
   * `<sessionId>.json` file into the in-memory cache. Files matching the
   * temp-write marker (`.tmp-...`) are ignored. Files that fail to read
   * or parse are skipped with a structured `session_load_failed` warning
   * on stderr; init never aborts due to a single bad file.
   *
   * Implements R15.5, R15.6, R15.7.
   */
  public async init(): Promise<void> {
    await this.fs.mkdir(this.storageDir, { recursive: true });
    let entries: string[];
    try {
      entries = await this.fs.readdir(this.storageDir);
    } catch (err) {
      // The mkdir above should have made readdir succeed; if not, surface
      // the error to the caller — there is nothing useful we can do.
      throw err instanceof Error ? err : new Error(String(err));
    }
    for (const name of entries) {
      if (!name.endsWith(SESSION_EXT)) continue;
      if (name.includes(TMP_MARKER)) continue;
      const filepath = nodePath.join(this.storageDir, name);
      let raw: string;
      try {
        raw = await this.fs.readFile(filepath, 'utf8');
      } catch (err) {
        this.warnLoadFailed(name, err);
        continue;
      }
      try {
        const parsed = parsePrettyPrinted<Session>(raw);
        if (!isSession(parsed)) {
          this.warnLoadFailed(name, new Error('invalid_session_shape'));
          continue;
        }
        this.cache.set(parsed.sessionId, parsed);
      } catch (err) {
        this.warnLoadFailed(name, err);
      }
    }
  }

  /** Look up a session in the in-memory cache. */
  public get(sessionId: SessionId): Session | undefined {
    return this.cache.get(sessionId);
  }

  /** Snapshot of every session currently in the cache. */
  public list(): Session[] {
    return Array.from(this.cache.values());
  }

  /** Number of sessions currently cached in memory. */
  public size(): number {
    return this.cache.size;
  }

  /**
   * Update the in-memory cache and persist to disk.
   *
   * The cache is mutated synchronously *before* any I/O so callers that
   * race with a disk failure still observe the latest message history
   * (R15.8 retention). The on-disk write is atomic (write to a unique
   * `.tmp-<suffix>` then rename, R19.6) and retried up to 3 times with
   * `200 ms × attempt` backoff. After all three attempts fail the
   * `onPersistFailure` hook is invoked and `false` is returned; the
   * cache is left untouched and the next `save()` will retry.
   *
   * @returns `true` when the file was successfully written, `false`
   *          when all three attempts failed.
   *
   * Implements R15.2, R15.8, R19.6.
   */
  public async save(session: Session): Promise<boolean> {
    // R15.8: cache update is synchronous so it survives disk failure.
    this.cache.set(session.sessionId, session);

    const sessionPath = this.pathFor(session.sessionId);
    const content = prettyPrint('Session', session);

    let lastError: Error = new Error('save_unreached');
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.writeAtomic(sessionPath, content);
        return true;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_ATTEMPTS && !this.disposed) {
          await this.sleep(RETRY_BACKOFF_MS * attempt);
        }
      }
    }

    if (this.onPersistFailure) {
      try {
        this.onPersistFailure(session.sessionId, lastError);
      } catch {
        // The notification hook must not crash the store. Swallow.
      }
    }
    return false;
  }

  /**
   * Remove a session from the cache and unlink its on-disk file.
   * Tolerates an already-removed file (`ENOENT`); other unlink errors
   * propagate.
   *
   * @returns `true` if the session existed in the cache.
   *
   * Implements R15.7.
   */
  public async delete(sessionId: SessionId): Promise<boolean> {
    const existed = this.cache.delete(sessionId);
    const sessionPath = this.pathFor(sessionId);
    try {
      await this.fs.unlink(sessionPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ENOENT') {
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
    return existed;
  }

  /** Stop any pending retry timers. Idempotent. */
  public dispose(): void {
    this.disposed = true;
    for (const t of this.pendingTimers) {
      clearTimeout(t);
    }
    this.pendingTimers.clear();
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /** Path to the canonical on-disk file for a session. */
  private pathFor(sessionId: SessionId): string {
    return nodePath.join(this.storageDir, `${sessionId}${SESSION_EXT}`);
  }

  /**
   * Atomic write algorithm: ensure the storage directory exists, write
   * the payload to a unique temp filename in the same directory, then
   * rename onto the destination. The random suffix prevents collisions
   * when two `save()` calls race for the same session id. On any error
   * a best-effort `unlink` of the temp file is attempted before the
   * error is rethrown.
   *
   * Implements R19.6 — readers either see the previous file content or
   * the new one, never a partial write.
   */
  private async writeAtomic(sessionPath: string, content: string): Promise<void> {
    const suffix = `${this.now()}-${Math.random().toString(36).slice(2)}`;
    const tmp = `${sessionPath}${TMP_MARKER}${suffix}`;
    try {
      await this.fs.mkdir(this.storageDir, { recursive: true });
      await this.fs.writeFile(tmp, content, 'utf8');
      await this.fs.rename(tmp, sessionPath);
    } catch (err) {
      try {
        await this.fs.unlink(tmp);
      } catch {
        // Best-effort cleanup; the original error is what matters.
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Cancellable sleep used by the save-retry loop. Tracks the timer
   * handle so {@link dispose} can clear it. If the store is disposed
   * mid-sleep, the promise resolves immediately so awaiting code can
   * unwind without leaking the handle.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const handle = setTimeout(() => {
        this.pendingTimers.delete(handle);
        resolve();
      }, ms);
      this.pendingTimers.add(handle);
    });
  }

  /**
   * Emit a structured `session_load_failed` line to stderr (one JSON
   * object per line). Used by {@link init} to skip a malformed file
   * without aborting the whole load. Never throws — failure to log is
   * swallowed.
   */
  private warnLoadFailed(file: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const line = JSON.stringify({
      ts: new Date(this.now()).toISOString(),
      level: 'warn',
      msg: 'session_load_failed',
      file,
      err: message,
    });
    try {
      process.stderr.write(`${line}\n`);
    } catch {
      // If stderr itself is unavailable there is nothing more we can do.
    }
  }
}

/**
 * Structural type-guard for a parsed {@link Session}. Used by `init` to
 * reject objects that round-trip through `JSON.parse` but do not match
 * the wire shape (e.g. user-edited files).
 */
function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === 'string' &&
    typeof v.createdAt === 'number' &&
    typeof v.updatedAt === 'number' &&
    Array.isArray(v.messages)
  );
}
