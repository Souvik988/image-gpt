/**
 * Asset cache — content-addressed skip-regeneration for MCP tools.
 *
 * The manifest maps sha256(prompt) → { savedPath, mimeType, createdAt }
 * and lives at `<workspaceRoot>/.kiro-gpt-cache.json`. Because the cache
 * key is the FINAL composed prompt — which already embeds the
 * workspace's design brief from `designContext.ts` — any change to the
 * project's palette / typography / stack naturally invalidates the entry.
 * A cache hit therefore means "the user asked for the identical asset in
 * an identical design system", and re-generating it would waste a
 * 10-60 s generation round-trip.
 *
 * Behaviour:
 *  - Opt-out per call (`cache: false`) — the tools default to ON.
 *  - A hit only counts when the recorded file still exists on disk.
 *  - The manifest is capped (oldest entries dropped) and written
 *    atomically (tmp + rename). A corrupt / unreadable manifest is
 *    treated as absent — caching must never break generation.
 *
 * @packageDocumentation
 */

import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

import type { ImageMimeType } from './pathResolver.js';

// ─── Public types ──────────────────────────────────────────────────────────

/** One manifest entry. */
export interface AssetCacheEntry {
  /** Absolute path of the generated file. */
  savedPath: string;
  /** MIME type recorded at write time. */
  mimeType: ImageMimeType;
  /** Epoch ms when the entry was recorded. */
  createdAt: number;
}

/** Result of {@link lookupCachedAsset}. */
export interface AssetCacheHit {
  savedPath: string;
  mimeType: ImageMimeType;
  /** The cache key (sha256 prefix) that matched. */
  hash: string;
}

/** On-disk manifest shape. */
interface CacheManifest {
  version: 1;
  entries: Record<string, AssetCacheEntry>;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Manifest filename inside the workspace root. */
const MANIFEST_FILENAME = '.kiro-gpt-cache.json';

/** Maximum retained entries; the oldest drop first. */
const MAX_ENTRIES = 500;

/** Length of the hash key stored in the manifest. */
const HASH_LEN = 16;

// ─── Pure helpers (exported for tests) ─────────────────────────────────────

/**
 * Compute the cache key for a final prompt: first 16 hex chars of
 * sha256. Stable across processes and platforms.
 */
export function computePromptHash(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex').slice(0, HASH_LEN);
}

/** Manifest path for a workspace root. */
export function manifestPathFor(workspaceRoot: string): string {
  return path.join(workspaceRoot, MANIFEST_FILENAME);
}

// ─── Core operations ───────────────────────────────────────────────────────

/**
 * Look up a cached asset for `prompt`. Returns a hit only when the
 * manifest contains the hash AND the recorded file still exists.
 * Never throws — any error (missing manifest, corrupt JSON, fs failure)
 * resolves to `null`.
 */
export async function lookupCachedAsset(
  workspaceRoot: string,
  prompt: string,
): Promise<AssetCacheHit | null> {
  const hash = computePromptHash(prompt);
  try {
    const raw = await fsp.readFile(manifestPathFor(workspaceRoot), 'utf8');
    const manifest = JSON.parse(raw) as CacheManifest;
    if (manifest.version !== 1 || manifest.entries === null || typeof manifest.entries !== 'object') {
      return null;
    }
    const entry = manifest.entries[hash];
    if (entry === undefined || typeof entry.savedPath !== 'string') return null;
    // A hit counts only when the file is still on disk.
    if (!fsSync.existsSync(entry.savedPath)) return null;
    if (!isSupportedMime(entry.mimeType)) return null;
    return { savedPath: entry.savedPath, mimeType: entry.mimeType, hash };
  } catch {
    return null;
  }
}

/**
 * Record a successful generation in the manifest. Atomic (tmp + rename)
 * and capped at {@link MAX_ENTRIES} (oldest dropped). Never throws — a
 * cache-write failure must not fail the generation that produced it.
 */
export async function recordCachedAsset(
  workspaceRoot: string,
  prompt: string,
  savedPath: string,
  mimeType: ImageMimeType,
): Promise<void> {
  const hash = computePromptHash(prompt);
  const manifestFile = manifestPathFor(workspaceRoot);
  try {
    let manifest: CacheManifest = { version: 1, entries: {} };
    try {
      const raw = await fsp.readFile(manifestFile, 'utf8');
      const parsed = JSON.parse(raw) as CacheManifest;
      if (parsed.version === 1 && parsed.entries !== null && typeof parsed.entries === 'object') {
        manifest = parsed;
      }
    } catch {
      // Missing or corrupt manifest — start fresh.
    }

    manifest.entries[hash] = { savedPath, mimeType, createdAt: Date.now() };

    // Cap: drop the oldest entries beyond the limit.
    const keys = Object.keys(manifest.entries);
    if (keys.length > MAX_ENTRIES) {
      const sorted = keys.sort(
        (a, b) => (manifest.entries[a]?.createdAt ?? 0) - (manifest.entries[b]?.createdAt ?? 0),
      );
      for (const key of sorted.slice(0, keys.length - MAX_ENTRIES)) {
        delete manifest.entries[key];
      }
    }

    const tmp = `${manifestFile}.tmp-${randomBytes(6).toString('hex')}`;
    await fsp.mkdir(path.dirname(manifestFile), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
    await fsp.rename(tmp, manifestFile);
  } catch {
    // Cache bookkeeping is best-effort by design.
  }
}

// ─── Internals ─────────────────────────────────────────────────────────────

const SUPPORTED_MIME: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

function isSupportedMime(value: unknown): value is ImageMimeType {
  return typeof value === 'string' && SUPPORTED_MIME.has(value);
}
