/**
 * Unit tests for `assetCache.ts` — the content-addressed
 * skip-regeneration manifest. Covers hash stability, record/lookup
 * round-trip, missing-file invalidation, corrupt-manifest tolerance,
 * and the entry cap.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  computePromptHash,
  lookupCachedAsset,
  manifestPathFor,
  recordCachedAsset,
} from '../src/assetCache.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kiro-cache-'));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('computePromptHash', () => {
  it('is stable across calls and sensitive to input', () => {
    expect(computePromptHash('hello world')).toBe(computePromptHash('hello world'));
    expect(computePromptHash('hello world')).not.toBe(computePromptHash('hello worlds'));
  });

  it('returns 16 hex characters', () => {
    const hash = computePromptHash('anything');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('record + lookup round-trip', () => {
  it('returns the recorded hit for an identical prompt', async () => {
    const target = path.join(tmpDir, 'public', 'logo', 'acme.png');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, 'png-bytes');

    await recordCachedAsset(tmpDir, 'prompt A', target, 'image/png');

    const hit = await lookupCachedAsset(tmpDir, 'prompt A');
    expect(hit).not.toBeNull();
    expect(hit?.savedPath).toBe(target);
    expect(hit?.mimeType).toBe('image/png');
    expect(hit?.hash).toBe(computePromptHash('prompt A'));
  });

  it('misses for a different prompt', async () => {
    const target = path.join(tmpDir, 'a.png');
    await fsp.writeFile(target, 'x');
    await recordCachedAsset(tmpDir, 'prompt A', target, 'image/png');
    expect(await lookupCachedAsset(tmpDir, 'prompt B')).toBeNull();
  });

  it('misses when the recorded file no longer exists', async () => {
    const target = path.join(tmpDir, 'gone.png');
    await fsp.writeFile(target, 'x');
    await recordCachedAsset(tmpDir, 'prompt A', target, 'image/png');
    await fsp.unlink(target);
    expect(await lookupCachedAsset(tmpDir, 'prompt A')).toBeNull();
  });

  it('tolerates a corrupt manifest as an empty cache', async () => {
    await fsp.writeFile(manifestPathFor(tmpDir), '{not json', 'utf8');
    expect(await lookupCachedAsset(tmpDir, 'prompt A')).toBeNull();
    // Recording repairs the manifest for future lookups.
    const target = path.join(tmpDir, 'b.png');
    await fsp.writeFile(target, 'x');
    await recordCachedAsset(tmpDir, 'prompt B', target, 'image/webp');
    expect(await lookupCachedAsset(tmpDir, 'prompt B')).not.toBeNull();
  });

  it('caps the manifest at 500 entries, dropping the oldest', async () => {
    const target = path.join(tmpDir, 'c.png');
    await fsp.writeFile(target, 'x');
    for (let i = 0; i < 502; i += 1) {
      await recordCachedAsset(tmpDir, `prompt-${i}`, target, 'image/png');
    }
    const raw = JSON.parse(await fsp.readFile(manifestPathFor(tmpDir), 'utf8')) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(raw.entries).length).toBe(500);
    // The oldest prompt was dropped; the newest survives.
    expect(await lookupCachedAsset(tmpDir, 'prompt-0')).toBeNull();
    expect(await lookupCachedAsset(tmpDir, 'prompt-501')).not.toBeNull();
  });
});
