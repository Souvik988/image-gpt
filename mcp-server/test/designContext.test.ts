/**
 * Unit tests for `designContext.ts` — the workspace design-system
 * analyzer. Covers color/font/radius extraction, framework
 * fingerprints, dark-mode detection, bounded scans, and the
 * one-line brief rendering.
 */

import { describe, it, expect } from 'vitest';

import {
  analyzeDesignContext,
  describeDesignContext,
  extractColors,
  extractCssVariables,
  extractFontFamilies,
} from '../src/designContext.js';

describe('extractColors', () => {
  it('extracts 3-, 6-, and 8-digit hex colors, normalized to lowercase', () => {
    const sink = new Set<string>();
    extractColors("colors: { primary: '#0F172A', accent: '#38bdf8', glow: '#AABBCCDD' }", sink);
    expect([...sink]).toEqual(['#0f172a', '#38bdf8', '#aabbccdd']);
  });

  it('expands 4-digit hex and 3-digit hex forms', () => {
    const sink = new Set<string>();
    extractColors('a: #abc; b: #abcd', sink);
    expect([...sink]).toContain('#aabbcc');
    expect([...sink]).toContain('#aabbccdd');
  });

  it('extracts rgb() and rgba() literals without spaces', () => {
    const sink = new Set<string>();
    extractColors('one: rgb( 15, 23, 42 ); two: rgba(56, 189, 248, 0.5)', sink);
    expect([...sink]).toEqual(['rgb(15,23,42)', 'rgba(56,189,248,0.5)']);
  });

  it('stops at the 24-color cap', () => {
    const sink = new Set<string>();
    const many = Array.from({ length: 40 }, (_, i) => `#aa00${String(i).padStart(2, '0')}`).join(' ');
    extractColors(many, sink);
    expect(sink.size).toBe(24);
  });
});

describe('extractCssVariables', () => {
  it('routes --*-radius values to the radius sink and colors to the color sink', () => {
    const colors = new Set<string>();
    const radii = new Set<string>();
    extractCssVariables(
      ':root { --color-primary: #0F172A; --radius-lg: 0.75rem; --brand: rgb(10,10,10); }',
      colors,
      radii,
    );
    expect([...colors]).toEqual(['#0f172a', 'rgb(10,10,10)']);
    expect([...radii]).toEqual(['0.75rem']);
  });
});

describe('extractFontFamilies', () => {
  it('reads Tailwind fontFamily arrays and skips generic families', () => {
    const sink = new Set<string>();
    extractFontFamilies(
      "fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'], display: ['\"Space Grotesk\"'] }",
      sink,
    );
    expect([...sink]).toEqual(['Inter', 'Space Grotesk']);
  });

  it('reads CSS font-family declarations', () => {
    const sink = new Set<string>();
    extractFontFamilies('body { font-family: "JetBrains Mono", monospace; }', sink);
    expect([...sink]).toEqual(['JetBrains Mono']);
  });
});

describe('describeDesignContext', () => {
  it('returns an empty string for an empty context', () => {
    const brief = describeDesignContext({
      framework: 'unknown',
      colors: [],
      fonts: [],
      radii: [],
      packages: [],
      darkMode: false,
      brief: '',
    });
    expect(brief).toBe('');
  });

  it('renders a single-line brief with brand, palette, fonts, and dark mode', () => {
    const brief = describeDesignContext({
      framework: 'next',
      brandName: 'acme',
      colors: ['#0f172a', '#38bdf8'],
      fonts: ['Inter'],
      radii: ['0.75rem'],
      packages: ['tailwindcss'],
      darkMode: true,
      brief: '',
    });
    expect(brief).toContain('brand "acme"');
    expect(brief).toContain('#0f172a');
    expect(brief).toContain('Inter');
    expect(brief).toContain('dark-mode aware');
    expect(brief).not.toContain('\n');
  });
});

describe('analyzeDesignContext', () => {
  it('derives framework, stack, colors, and brief from a synthetic workspace', async () => {
    const files = new Map<string, string>([
      [
        '/ws/package.json',
        JSON.stringify({
          name: '@acme/web',
          dependencies: { next: '14.0.0', tailwindcss: '3.4.0', 'next-themes': '0.2.0' },
        }),
      ],
      [
        '/ws/tailwind.config.ts',
        "export default { darkMode: 'class', theme: { extend: { colors: { primary: '#0F172A', accent: '#38BDF8' }, fontFamily: { sans: ['Inter'] } } } };",
      ],
      [
        '/ws/src/globals.css',
        ':root { --color-primary: #0f172a; --radius-lg: 0.75rem; } .dark {}',
      ],
    ]);
    const exists = (p: string): boolean => {
      const key = p.split(String.fromCharCode(92)).join('/');
      if (files.has(key)) return true;
      // Directories exist when any file lives beneath them.
      const prefix = key.endsWith('/') ? key : key + '/';
      for (const f of files.keys()) {
        if (f.startsWith(prefix)) return true;
      }
      return false;
    };

    const readFile = async (p: string): Promise<string> => {
      const key = p.split(String.fromCharCode(92)).join('/');
      const raw = files.get(key);
      if (raw === undefined) throw new Error(`ENOENT: ${key}`);
      return raw;
    };

    const readdir = (p: string): Array<{ name: string; isDirectory(): boolean }> => {
      const key = p.split(String.fromCharCode(92)).join('/');
      if (key === '/ws/src') {
        return [{ name: 'globals.css', isDirectory: (): boolean => false }];
      }
      return [];
    };

    const ctx = await analyzeDesignContext('/ws', { exists, readFile, readdir });

    expect(ctx.framework).toBe('next');
    expect(ctx.brandName).toBe('web');
    expect(ctx.colors).toContain('#0f172a');
    expect(ctx.colors).toContain('#38bdf8');
    expect(ctx.fonts).toContain('Inter');
    expect(ctx.radii).toContain('0.75rem');
    expect(ctx.packages).toContain('tailwindcss');
    expect(ctx.darkMode).toBe(true);
    expect(ctx.brief).toContain('brand "web"');
    expect(ctx.brief).not.toContain('\n');
  });

  it('never throws on a nonexistent workspace and falls back to unknown', async () => {
    const ctx = await analyzeDesignContext('/does-not-exist', {
      exists: () => false,
      readFile: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(ctx.framework).toBe('unknown');
    expect(ctx.colors).toEqual([]);
    expect(ctx.brief).toBe('');
  });
});
