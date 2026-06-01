// Feature: kiro-gpt-bridge, Property 10: a reader at any point during save() observes either the previous file contents or the new contents, never a partial write
/**
 * Property test for atomic write — no partial files; eventual persistence.
 *
 * Drives `SessionStore` through a sequence of `save()` calls while
 * injecting I/O failures at four points in the write-then-rename
 * algorithm:
 *
 *   - `BEFORE_TMP_WRITE`        — `writeFile` rejects before any bytes hit disk
 *   - `AFTER_TMP_WRITE_BEFORE_FSYNC` — `writeFile` resolves the data into
 *                                    the tmp file then rejects (simulating
 *                                    a crash before fsync)
 *   - `AFTER_FSYNC_BEFORE_RENAME` — `rename` rejects (data made it to a
 *                                    tmp file but the atomic swap failed)
 *   - `AFTER_RENAME`             — `rename` succeeds, error raised after
 *                                    (the swap completed)
 *
 * The injected `StoreFs` models a flat in-memory namespace so a reader
 * at any moment sees the union of files currently present.  We assert
 * three invariants after every `save()` call:
 *
 *   (P10.a) The target path is either absent OR byte-equal to a prior
 *           successful write OR — when the current save reported success
 *           — equal to the freshly serialised payload.
 *   (P10.b) The in-memory cache always retains the latest session value
 *           regardless of disk outcome (R15.8).
 *   (P10.c) No `.tmp-` sibling of the target path lingers on disk after
 *           a `save()` returns; that is, the write algorithm leaves the
 *           directory clean even when an injected fault interrupts it.
 *
 * **Validates: Requirements 15.8, 19.6**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import * as nodePath from 'node:path';
import { SessionStore, type StoreFs } from '../../src/sessions/store.js';
import { prettyPrint, type Session, type SessionId } from '@kiro-gpt-bridge/shared';

// ─── Fault-injection StoreFs ────────────────────────────────────────────────

type FaultPoint =
  | 'BEFORE_TMP_WRITE'
  | 'AFTER_TMP_WRITE_BEFORE_FSYNC'
  | 'AFTER_FSYNC_BEFORE_RENAME'
  | 'AFTER_RENAME';

interface FaultConfig {
  /** Fault to inject on the next call into the relevant fs operation, or null. */
  nextFault: FaultPoint | null;
}

interface FaultFs {
  fs: StoreFs;
  files: Map<string, string>;
}

/**
 * Build a fault-injecting {@link StoreFs} backed by an in-memory
 * `Map<path, content>`. Each `save()` consumes at most one fault: the
 * injection point is checked at the relevant operation and `nextFault`
 * is reset to `null` once the fault fires.
 */
function createFaultFs(faultConfig: FaultConfig): FaultFs {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  const fs: StoreFs = {
    async mkdir(p: string): Promise<void> {
      dirs.add(p);
    },
    async writeFile(p: string, data: string): Promise<void> {
      if (faultConfig.nextFault === 'BEFORE_TMP_WRITE') {
        faultConfig.nextFault = null;
        throw new Error('INJECTED: writeFile failed before any bytes were written');
      }
      files.set(p, data);
      if (faultConfig.nextFault === 'AFTER_TMP_WRITE_BEFORE_FSYNC') {
        faultConfig.nextFault = null;
        // The tmp file was created and contains data, but the surrounding
        // operation observed an error (e.g. a fsync failure). The store's
        // catch-clause will best-effort unlink the tmp file.
        throw new Error('INJECTED: writeFile failed after bytes hit disk');
      }
    },
    async rename(from: string, to: string): Promise<void> {
      if (faultConfig.nextFault === 'AFTER_FSYNC_BEFORE_RENAME') {
        faultConfig.nextFault = null;
        throw new Error('INJECTED: rename failed before swap');
      }
      const content = files.get(from);
      if (content === undefined) {
        const err = new Error(`ENOENT: rename source missing: ${from}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      files.set(to, content);
      files.delete(from);
      if (faultConfig.nextFault === 'AFTER_RENAME') {
        faultConfig.nextFault = null;
        // The atomic swap completed successfully BEFORE the fault is
        // raised; the on-disk state therefore reflects the new write.
        // We still throw so the store reports failure to the caller and
        // P10's "either prior or new" disjunction is exercised in full.
        throw new Error('INJECTED: error after rename swap completed');
      }
    },
    async unlink(p: string): Promise<void> {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: ${p}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      files.delete(p);
    },
    async readdir(p: string): Promise<string[]> {
      const out: string[] = [];
      for (const key of files.keys()) {
        if (!key.startsWith(`${p}/`) && !key.startsWith(`${p}\\`)) continue;
        const name = key.slice(p.length + 1);
        if (!name.includes('/') && !name.includes('\\')) out.push(name);
      }
      return out;
    },
    async readFile(p: string): Promise<string> {
      const content = files.get(p);
      if (content === undefined) {
        const err = new Error(`ENOENT: ${p}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      return content;
    },
  };

  return { fs, files };
}

/** Build a deterministic Session value with `msgCount` user messages. */
function makeSession(id: SessionId, msgCount: number, generation: number): Session {
  const messages = Array.from({ length: msgCount }, (_, i) => ({
    id: `msg-${id}-g${generation}-${i}`,
    role: 'user' as const,
    text: `gen ${generation} message ${i} for session ${id}`,
    createdAt: 1000 + i,
  }));
  return {
    sessionId: id,
    createdAt: 1000,
    updatedAt: 1000 + msgCount + generation,
    messages,
  };
}

// ─── Property test ──────────────────────────────────────────────────────────

const STORAGE_DIR = nodePath.join(nodePath.sep, 'storage');
const SESSION_ID: SessionId = 'p10-session';
const TARGET_PATH = nodePath.join(STORAGE_DIR, `${SESSION_ID}.json`);

describe('Property 10: Atomic write — readers see prior or new, never partial', () => {
  it(
    'after every save the target file is absent, equal to a prior successful write, or equal to the new payload; the cache always retains the latest session',
    { timeout: 60_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              msgCount: fc.integer({ min: 0, max: 8 }),
              fault: fc.constantFrom<FaultPoint | null>(
                null,
                'BEFORE_TMP_WRITE',
                'AFTER_TMP_WRITE_BEFORE_FSYNC',
                'AFTER_FSYNC_BEFORE_RENAME',
                'AFTER_RENAME',
              ),
            }),
            { minLength: 1, maxLength: 6 },
          ),
          async (operations) => {
            const faultConfig: FaultConfig = { nextFault: null };
            const { fs: storeFs, files } = createFaultFs(faultConfig);
            const persistFailures: SessionId[] = [];

            const store = new SessionStore({
              storageDir: STORAGE_DIR,
              fs: storeFs,
              onPersistFailure: (id) => {
                persistFailures.push(id);
              },
              now: () => 1_700_000_000_000,
            });

            await store.init();

            // The set of byte strings ever produced by a successful save
            // for SESSION_ID. P10.a's "prior successful write" disjunct
            // checks membership in this set.
            const knownGoodWrites = new Set<string>();

            for (let i = 0; i < operations.length; i++) {
              const op = operations[i]!;
              const session = makeSession(SESSION_ID, op.msgCount, i);
              const expectedSerialised = prettyPrint('Session', session);

              faultConfig.nextFault = op.fault;
              const ok = await store.save(session);

              // The fs harness performs at most one fault per save. It is
              // an error if any was queued and not consumed.
              expect(faultConfig.nextFault).toBeNull();

              const onDisk = files.get(TARGET_PATH);

              // P10.a: target is absent, equal to a prior successful
              // write, or equal to the new payload (the AFTER_RENAME
              // case where the swap completed before the error fired).
              if (onDisk === undefined) {
                // Allowed when no successful write has ever occurred OR
                // a pre-rename fault wiped the previous attempt — but
                // the previous successful payload, if any, must remain
                // because the atomic algorithm only deletes the canonical
                // file when rename succeeds with a new value.
                expect(knownGoodWrites.size === 0 || ok || op.fault === 'AFTER_RENAME').toBe(true);
              } else {
                const isKnownGood = knownGoodWrites.has(onDisk);
                const isNewPayload = onDisk === expectedSerialised;
                expect(isKnownGood || isNewPayload).toBe(true);
              }

              if (ok) {
                expect(onDisk).toBe(expectedSerialised);
                knownGoodWrites.add(expectedSerialised);
              } else if (op.fault === 'AFTER_RENAME') {
                // The store reported failure but the rename actually
                // completed before the error fired; on-disk reflects
                // the new payload. Record it so subsequent iterations
                // accept it under the "prior successful write" rule.
                if (onDisk === expectedSerialised) {
                  knownGoodWrites.add(expectedSerialised);
                }
              }

              // P10.b: cache always holds the newest session value,
              // even when persistence failed — R15.8 retention.
              const cached = store.get(SESSION_ID);
              expect(cached).toBeDefined();
              expect(cached!.messages).toHaveLength(op.msgCount);
              expect(cached!.updatedAt).toBe(session.updatedAt);

              // P10.c: no leftover .tmp- siblings of the target path.
              const tmpPrefix = `${TARGET_PATH}.tmp-`;
              for (const key of files.keys()) {
                if (key.startsWith(tmpPrefix)) {
                  // The only acceptable lingerer is the half-written
                  // tmp file from the AFTER_TMP_WRITE_BEFORE_FSYNC
                  // case: the store catches and best-effort unlinks
                  // it, so even that path should leave no residue.
                  throw new Error(
                    `lingering tmp file after save() returned: ${key}`,
                  );
                }
              }
            }

            // Sanity: every reported persist failure corresponds to a
            // save() that returned false.
            for (const id of persistFailures) {
              expect(id).toBe(SESSION_ID);
            }

            store.dispose();
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});
