/**
 * Unit tests for `saveMarkdown` and `saveImage` filename validation and
 * overwrite behavior.
 *
 * Covers (R17.4–R17.9, R19.1–R19.6):
 *  - Windows reserved device names (CON, PRN, AUX, NUL, COM1–9, LPT1–9).
 *  - Illegal characters: `< > : " / \ | ? *` and control chars 0x00–0x1F.
 *  - Length bounds: 1..255 chars; trailing dot/space rejection.
 *  - Overwrite paths: explicit confirm, explicit decline, dismiss-without-
 *    choice timestamp suffix.
 *  - No-workspace error path.
 *  - Atomic write success via tmp file + rename.
 *  - Atomic write failure leaves no partial file at the target path.
 *  - saveImage: should-not-save when the response carried an error code
 *    (R17.9).
 *
 * The save flows are written to be VS Code-free (host bindings are
 * passed in as `SaveMarkdownContext` / `SaveImageContext`), so these
 * tests do not need to mock `vscode`.
 *
 * _Implements: R17.4, R17.5, R17.6, R17.7, R17.8, R19.1, R19.2, R19.3,
 *              R19.4, R19.5, R19.6_
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';

import {
  saveMarkdown,
  isValidFilename as isValidMarkdownFilename,
  timestampSuffix,
  type SaveMarkdownContext,
  type SaveMarkdownFs,
  type SaveMarkdownResult,
} from '../src/files/saveMarkdown.js';
import {
  saveImage,
  deriveExtension,
  isValidFilename as isValidImageFilename,
  type SaveImageContext,
  type SaveImageFs,
  type SaveImageResult,
} from '../src/files/saveImage.js';
import { base64Encode } from '@kiro-gpt-bridge/shared';

// ─── In-memory fs ──────────────────────────────────────────────────────────

interface MemoryFile {
  data: Uint8Array | string;
}

interface MemoryFs {
  mdFs: SaveMarkdownFs;
  imageFs: SaveImageFs;
  files: Map<string, MemoryFile>;
  failNextWrite: boolean;
  failNextRename: boolean;
  unlinkCalls: string[];
}

function createMemoryFs(): MemoryFs {
  const files = new Map<string, MemoryFile>();
  const unlinkCalls: string[] = [];
  const memory: MemoryFs = {
    files,
    unlinkCalls,
    failNextWrite: false,
    failNextRename: false,
    mdFs: {
      exists: (p: string): Promise<boolean> => Promise.resolve(files.has(p)),
      mkdir: (_p: string, _opts: { recursive: true }): Promise<void> =>
        Promise.resolve(),
      writeFile: (
        p: string,
        data: string,
        _encoding: 'utf8',
      ): Promise<void> => {
        if (memory.failNextWrite) {
          memory.failNextWrite = false;
          return Promise.reject(new Error('disk full'));
        }
        files.set(p, { data });
        return Promise.resolve();
      },
      rename: (from: string, to: string): Promise<void> => {
        if (memory.failNextRename) {
          memory.failNextRename = false;
          return Promise.reject(new Error('rename failed'));
        }
        const f = files.get(from);
        if (!f) return Promise.reject(new Error(`ENOENT: ${from}`));
        files.delete(from);
        files.set(to, f);
        return Promise.resolve();
      },
      unlink: (p: string): Promise<void> => {
        unlinkCalls.push(p);
        files.delete(p);
        return Promise.resolve();
      },
    },
    imageFs: {
      exists: (p: string): Promise<boolean> => Promise.resolve(files.has(p)),
      mkdir: (_p: string, _opts: { recursive: true }): Promise<void> =>
        Promise.resolve(),
      writeFile: (p: string, data: Uint8Array): Promise<void> => {
        if (memory.failNextWrite) {
          memory.failNextWrite = false;
          return Promise.reject(new Error('disk full'));
        }
        files.set(p, { data });
        return Promise.resolve();
      },
      rename: (from: string, to: string): Promise<void> => {
        if (memory.failNextRename) {
          memory.failNextRename = false;
          return Promise.reject(new Error('rename failed'));
        }
        const f = files.get(from);
        if (!f) return Promise.reject(new Error(`ENOENT: ${from}`));
        files.delete(from);
        files.set(to, f);
        return Promise.resolve();
      },
      unlink: (p: string): Promise<void> => {
        unlinkCalls.push(p);
        files.delete(p);
        return Promise.resolve();
      },
    },
  };
  return memory;
}

// ─── isValidFilename: shared cases ──────────────────────────────────────────

describe('saveMarkdown.isValidFilename', () => {
  it('accepts plain alphanumerics within length bounds', () => {
    expect(isValidMarkdownFilename('notes.md')).toBe(true);
    expect(isValidMarkdownFilename('a.md')).toBe(true);
    expect(isValidMarkdownFilename('My-File_2024.md')).toBe(true);
  });

  it('rejects empty and over-long names', () => {
    expect(isValidMarkdownFilename('')).toBe(false);
    expect(isValidMarkdownFilename('a'.repeat(256))).toBe(false);
    expect(isValidMarkdownFilename('a'.repeat(255))).toBe(true);
  });

  it('rejects illegal characters from <>:"/\\|?* and control chars', () => {
    for (const c of ['<', '>', ':', '"', '/', '\\', '|', '?', '*']) {
      expect(isValidMarkdownFilename(`bad${c}name.md`)).toBe(false);
    }
    expect(isValidMarkdownFilename('null\u0000.md')).toBe(false);
    expect(isValidMarkdownFilename('bell\u0007.md')).toBe(false);
    expect(isValidMarkdownFilename('del\u007f.md')).toBe(false);
  });

  it('rejects trailing dot or space', () => {
    expect(isValidMarkdownFilename('foo.')).toBe(false);
    expect(isValidMarkdownFilename('foo ')).toBe(false);
  });

  it('rejects Windows reserved device names case-insensitively', () => {
    for (const reserved of [
      'CON',
      'PRN',
      'AUX',
      'NUL',
      'COM1',
      'COM9',
      'LPT1',
      'LPT9',
    ]) {
      expect(isValidMarkdownFilename(`${reserved}.md`)).toBe(false);
      expect(isValidMarkdownFilename(`${reserved.toLowerCase()}.md`)).toBe(false);
      expect(isValidMarkdownFilename(reserved)).toBe(false);
    }
  });

  it('does not reject names that merely contain a reserved substring', () => {
    expect(isValidMarkdownFilename('CONTEXT.md')).toBe(true);
    expect(isValidMarkdownFilename('LPT10.md')).toBe(true);
    expect(isValidMarkdownFilename('CON-1.md')).toBe(true);
  });
});

describe('saveImage.isValidFilename', () => {
  it('accepts plain alphanumerics within length bounds', () => {
    expect(isValidImageFilename('logo.png')).toBe(true);
    expect(isValidImageFilename('a.gif')).toBe(true);
  });

  it('rejects empty, over-long, illegal-char, trailing-dot, trailing-space, and reserved names', () => {
    expect(isValidImageFilename('')).toBe(false);
    expect(isValidImageFilename('a'.repeat(256))).toBe(false);
    expect(isValidImageFilename('bad/name.png')).toBe(false);
    expect(isValidImageFilename('bad?name.png')).toBe(false);
    expect(isValidImageFilename('null\u0000.png')).toBe(false);
    expect(isValidImageFilename('foo.')).toBe(false);
    expect(isValidImageFilename('foo ')).toBe(false);
    expect(isValidImageFilename('CON.png')).toBe(false);
    expect(isValidImageFilename('com1.png')).toBe(false);
    expect(isValidImageFilename('LPT9.png')).toBe(false);
  });
});

// ─── timestampSuffix ───────────────────────────────────────────────────────

describe('timestampSuffix', () => {
  it('formats local time as _YYYYMMDD-HHMMSS with zero-padding', () => {
    const d = new Date(2024, 0, 5, 7, 3, 9);
    expect(timestampSuffix(d)).toBe('_20240105-070309');
  });
  it('preserves 4-digit year and 2-digit other fields for year 2099', () => {
    const d = new Date(2099, 11, 31, 23, 59, 59);
    expect(timestampSuffix(d)).toBe('_20991231-235959');
  });
});

// ─── deriveExtension ───────────────────────────────────────────────────────

describe('deriveExtension', () => {
  it('maps every supported MIME type to the canonical extension', () => {
    expect(deriveExtension('image/png')).toBe('.png');
    expect(deriveExtension('image/jpeg')).toBe('.jpg');
    expect(deriveExtension('image/webp')).toBe('.webp');
    expect(deriveExtension('image/gif')).toBe('.gif');
  });
});

// ─── saveMarkdown: end-to-end ──────────────────────────────────────────────

describe('saveMarkdown end-to-end', () => {
  const ROOT = path.join(path.sep === '\\' ? 'C:' : '', 'workspace');

  function createCtx(memory: MemoryFs): {
    ctx: SaveMarkdownContext;
    promptResponses: (string | undefined)[];
    overwriteResponses: ('overwrite' | 'cancel' | undefined)[];
    errors: string[];
    infos: string[];
  } {
    const promptResponses: (string | undefined)[] = [];
    const overwriteResponses: ('overwrite' | 'cancel' | undefined)[] = [];
    const errors: string[] = [];
    const infos: string[] = [];
    const ctx: SaveMarkdownContext = {
      workspaceRoot: ROOT,
      promptFilename: () => Promise.resolve(promptResponses.shift()),
      promptOverwrite: () => Promise.resolve(overwriteResponses.shift()),
      showError: (m: string) => {
        errors.push(m);
      },
      showInfo: (m: string) => {
        infos.push(m);
      },
      fs: memory.mdFs,
    };
    return { ctx, promptResponses, overwriteResponses, errors, infos };
  }

  it('R19.5: returns no_workspace and shows error when no workspace folder is open', async () => {
    const memory = createMemoryFs();
    const { ctx, errors } = createCtx(memory);
    const noWs: SaveMarkdownContext = { ...ctx, workspaceRoot: null };
    const result = await saveMarkdown({ text: 'hi' }, noWs);
    expect(result).toEqual({ ok: false, reason: 'no_workspace' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('R19.1: writes UTF-8 atomically (tmp + rename) on a fresh filename', async () => {
    const memory = createMemoryFs();
    const { ctx, promptResponses, infos } = createCtx(memory);
    promptResponses.push('notes');
    const result = (await saveMarkdown(
      { text: 'hello world' },
      ctx,
    )) as SaveMarkdownResult;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedPath).toBe(path.join(ROOT, 'notes.md'));
      expect(memory.files.get(result.savedPath)?.data).toBe('hello world');
    }
    // No tmp file should remain.
    const remainingTmp = [...memory.files.keys()].filter((k) =>
      k.includes('.tmp-'),
    );
    expect(remainingTmp).toHaveLength(0);
    expect(infos[0]).toMatch(/^Saved /);
  });

  it('R19.1: re-prompts on Windows reserved name and accepts a valid follow-up', async () => {
    const memory = createMemoryFs();
    const { ctx, promptResponses, errors } = createCtx(memory);
    promptResponses.push('CON.md', 'fine.md');
    const result = await saveMarkdown({ text: 'x' }, ctx);
    expect(result.ok).toBe(true);
    expect(errors.length).toBe(1); // exactly one re-prompt error
  });

  it('R19.1: re-prompts on illegal char and gives up after MAX prompts', async () => {
    const memory = createMemoryFs();
    const { ctx, promptResponses, errors } = createCtx(memory);
    promptResponses.push('bad?one.md', 'bad/two.md', 'bad|three.md');
    const result = await saveMarkdown({ text: 'x' }, ctx);
    expect(result).toEqual({ ok: false, reason: 'invalid_filename' });
    expect(errors.length).toBe(3);
  });

  it('R19.1: returns cancelled when user dismisses the filename prompt', async () => {
    const memory = createMemoryFs();
    const { ctx, promptResponses } = createCtx(memory);
    promptResponses.push(undefined);
    const result = await saveMarkdown({ text: 'x' }, ctx);
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('R19.3: aborts without modifying file when user declines overwrite', async () => {
    const memory = createMemoryFs();
    const target = path.join(ROOT, 'existing.md');
    memory.files.set(target, { data: 'OLD' });
    const { ctx, promptResponses, overwriteResponses } = createCtx(memory);
    promptResponses.push('existing.md');
    overwriteResponses.push('cancel');
    const result = await saveMarkdown({ text: 'NEW' }, ctx);
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
    // File untouched.
    expect(memory.files.get(target)?.data).toBe('OLD');
  });

  it('R19.3: overwrites in place when user confirms', async () => {
    const memory = createMemoryFs();
    const target = path.join(ROOT, 'existing.md');
    memory.files.set(target, { data: 'OLD' });
    const { ctx, promptResponses, overwriteResponses } = createCtx(memory);
    promptResponses.push('existing.md');
    overwriteResponses.push('overwrite');
    const result = (await saveMarkdown(
      { text: 'NEW' },
      ctx,
    )) as SaveMarkdownResult;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedPath).toBe(target);
      expect(memory.files.get(target)?.data).toBe('NEW');
    }
  });

  it('R19.4: appends timestamp suffix when user dismisses overwrite prompt', async () => {
    const memory = createMemoryFs();
    const target = path.join(ROOT, 'existing.md');
    memory.files.set(target, { data: 'OLD' });
    const fixedNow = new Date(2024, 5, 15, 13, 45, 30);
    const { ctx, promptResponses, overwriteResponses } = createCtx(memory);
    promptResponses.push('existing.md');
    overwriteResponses.push(undefined);
    const ctxWithClock: SaveMarkdownContext = {
      ...ctx,
      now: () => fixedNow,
    };
    const result = (await saveMarkdown(
      { text: 'NEW' },
      ctxWithClock,
    )) as SaveMarkdownResult;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedPath).toBe(
        path.join(ROOT, 'existing_20240615-134530.md'),
      );
      // Original file untouched, new file written under suffixed name.
      expect(memory.files.get(target)?.data).toBe('OLD');
      expect(memory.files.get(result.savedPath)?.data).toBe('NEW');
    }
  });

  it('R19.6: write failure leaves no partial file at the target', async () => {
    const memory = createMemoryFs();
    memory.failNextWrite = true;
    const { ctx, promptResponses, errors } = createCtx(memory);
    promptResponses.push('fresh.md');
    const result = await saveMarkdown({ text: 'x' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('write_failed');
    }
    // No files should exist at the target or the tmp path.
    expect(memory.files.has(path.join(ROOT, 'fresh.md'))).toBe(false);
    expect(
      [...memory.files.keys()].some((k) => k.includes('.tmp-')),
    ).toBe(false);
    expect(errors.some((m) => m.includes('Failed to save'))).toBe(true);
  });

  it('R19.6: rename failure unlinks the tmp and reports write_failed', async () => {
    const memory = createMemoryFs();
    memory.failNextRename = true;
    const { ctx, promptResponses } = createCtx(memory);
    promptResponses.push('fresh.md');
    const result = await saveMarkdown({ text: 'x' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('write_failed');
    }
    // Target absent.
    expect(memory.files.has(path.join(ROOT, 'fresh.md'))).toBe(false);
    // The unlink helper was invoked on the tmp path.
    expect(memory.unlinkCalls.length).toBeGreaterThanOrEqual(1);
    // No tmp file remains in the in-memory fs (unlink ran successfully).
    expect(
      [...memory.files.keys()].some((k) => k.includes('.tmp-')),
    ).toBe(false);
  });
});

// ─── saveImage: end-to-end ─────────────────────────────────────────────────

describe('saveImage end-to-end', () => {
  const ROOT = path.join(path.sep === '\\' ? 'C:' : '', 'workspace');
  const PIXEL_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const PIXEL_PNG_B64 = base64Encode(PIXEL_PNG_BYTES);

  function createCtx(memory: MemoryFs): {
    ctx: SaveImageContext;
    promptResponses: (string | undefined)[];
    overwriteResponses: ('overwrite' | 'cancel' | undefined)[];
    errors: string[];
    infos: string[];
  } {
    const promptResponses: (string | undefined)[] = [];
    const overwriteResponses: ('overwrite' | 'cancel' | undefined)[] = [];
    const errors: string[] = [];
    const infos: string[] = [];
    const ctx: SaveImageContext = {
      workspaceRoot: ROOT,
      promptFilename: () => Promise.resolve(promptResponses.shift()),
      promptOverwrite: () => Promise.resolve(overwriteResponses.shift()),
      showError: (m: string) => {
        errors.push(m);
      },
      showInfo: (m: string) => {
        infos.push(m);
      },
      fs: memory.imageFs,
    };
    return { ctx, promptResponses, overwriteResponses, errors, infos };
  }

  it('R17.9: returns should_not_save when the response carried an errorCode', async () => {
    const memory = createMemoryFs();
    const { ctx } = createCtx(memory);
    const result = await saveImage(
      {
        mimeType: 'image/png',
        base64: PIXEL_PNG_B64,
        errorCode: 'IMAGE_TIMEOUT',
      },
      ctx,
    );
    expect(result).toEqual({ ok: false, reason: 'should_not_save' });
    // Nothing written.
    expect(memory.files.size).toBe(0);
  });

  it('R17.8: returns no_workspace and shows error when workspace is null', async () => {
    const memory = createMemoryFs();
    const { ctx, errors } = createCtx(memory);
    const noWs: SaveImageContext = { ...ctx, workspaceRoot: null };
    const result = await saveImage(
      { mimeType: 'image/png', base64: PIXEL_PNG_B64 },
      noWs,
    );
    expect(result).toEqual({ ok: false, reason: 'no_workspace' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('R17.5: auto-appends MIME-derived extension when user omits it', async () => {
    const memory = createMemoryFs();
    const { ctx, promptResponses } = createCtx(memory);
    promptResponses.push('logo'); // no extension
    const result = (await saveImage(
      { mimeType: 'image/png', base64: PIXEL_PNG_B64 },
      ctx,
    )) as SaveImageResult;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedPath).toBe(path.join(ROOT, 'logo.png'));
      const written = memory.files.get(result.savedPath)?.data as Uint8Array;
      expect(Array.from(written)).toEqual(Array.from(PIXEL_PNG_BYTES));
    }
  });

  it('R17.6: re-prompts on Windows reserved name and accepts a valid follow-up', async () => {
    const memory = createMemoryFs();
    const { ctx, promptResponses, errors } = createCtx(memory);
    promptResponses.push('CON.png', 'good.png');
    const result = await saveImage(
      { mimeType: 'image/png', base64: PIXEL_PNG_B64 },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(errors.length).toBe(1);
  });

  it('R17.6: gives up with invalid_filename after MAX_FILENAME_ATTEMPTS', async () => {
    const memory = createMemoryFs();
    const { ctx, promptResponses } = createCtx(memory);
    // All three attempts illegal in different ways. Each retains an
    // illegal character even after the auto-appended `.png` extension
    // so isValidFilename keeps rejecting them.
    promptResponses.push('bad?one.png', 'CON.png', 'bad|three.png');
    const result = await saveImage(
      { mimeType: 'image/png', base64: PIXEL_PNG_B64 },
      ctx,
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_filename' });
  });

  it('R17.7: aborts (cancelled) when target exists and user declines overwrite', async () => {
    const memory = createMemoryFs();
    const target = path.join(ROOT, 'existing.png');
    memory.files.set(target, { data: new Uint8Array([1, 2, 3]) });
    const { ctx, promptResponses, overwriteResponses } = createCtx(memory);
    promptResponses.push('existing.png');
    overwriteResponses.push('cancel');
    const result = await saveImage(
      { mimeType: 'image/png', base64: PIXEL_PNG_B64 },
      ctx,
    );
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
    // File untouched.
    const original = memory.files.get(target)?.data as Uint8Array;
    expect(Array.from(original)).toEqual([1, 2, 3]);
  });

  it('R17.7: overwrites in place when user confirms', async () => {
    const memory = createMemoryFs();
    const target = path.join(ROOT, 'existing.png');
    memory.files.set(target, { data: new Uint8Array([1, 2, 3]) });
    const { ctx, promptResponses, overwriteResponses } = createCtx(memory);
    promptResponses.push('existing.png');
    overwriteResponses.push('overwrite');
    const result = (await saveImage(
      { mimeType: 'image/png', base64: PIXEL_PNG_B64 },
      ctx,
    )) as SaveImageResult;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.savedPath).toBe(target);
      const written = memory.files.get(target)?.data as Uint8Array;
      expect(Array.from(written)).toEqual(Array.from(PIXEL_PNG_BYTES));
    }
  });

  it('R19.6: write failure leaves no partial file at the target', async () => {
    const memory = createMemoryFs();
    memory.failNextWrite = true;
    const { ctx, promptResponses } = createCtx(memory);
    promptResponses.push('fresh.png');
    const result = await saveImage(
      { mimeType: 'image/png', base64: PIXEL_PNG_B64 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('write_failed');
    }
    expect(memory.files.has(path.join(ROOT, 'fresh.png'))).toBe(false);
    expect(
      [...memory.files.keys()].some((k) => k.includes('.tmp-')),
    ).toBe(false);
  });

  it('R17.5: returns cancelled when user dismisses the filename prompt', async () => {
    const memory = createMemoryFs();
    const { ctx, promptResponses } = createCtx(memory);
    promptResponses.push(undefined);
    const result = await saveImage(
      { mimeType: 'image/png', base64: PIXEL_PNG_B64 },
      ctx,
    );
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
  });
});
