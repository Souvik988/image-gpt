/**
 * Design-context analyzer — the "UI understanding" brain of the MCP
 * server.
 *
 * Reads the caller's workspace (framework configs, Tailwind config,
 * CSS custom properties, package.json dependencies) and distils a
 * compact {@link DesignContext} that downstream prompt composition
 * injects into every generated prompt. This is what lets the agent
 * "understand the UI": instead of a generic "modern landing page" the
 * generated asset inherits the project's actual palette, typography,
 * corner-radius language, and stack.
 *
 * Detection strategy (best-effort, never throws):
 *  1. `package.json` — dependencies reveal the stack (next, nuxt,
 *     svelte, vue, react, angular, tailwindcss, shadcn, mantine, …)
 *     and the package name doubles as the brand-name hint.
 *  2. `tailwind.config.{js,ts,cjs,mjs}` — regex-extract hex/rgb colors
 *     and `fontFamily` entries. We deliberately parse text, never
 *     `eval` the config (untrusted code must not execute here).
 *  3. CSS / SCSS sources — walk a bounded file list (`src`, `styles`,
 *     `app`, `assets`) extracting `--custom-property` color values and
 *     `font-family` declarations.
 *  4. Framework fingerprints — config-file presence
 *     (next.config.*, nuxt.config.*, angular.json, svelte.config.*,
 *     vite.config.*).
 *
 * All scans are bounded (file count, byte size, result counts) so a
 * monorepo-scale workspace cannot blow up the stdio loop.
 *
 * @packageDocumentation
 */

import * as fsSync from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import type { Framework } from './pathResolver.js';

// ─── Public types ──────────────────────────────────────────────────────────

/** Distilled design system extracted from the workspace. */
export interface DesignContext {
  /** Detected framework fingerprint (falls back to `unknown`). */
  framework: Framework;
  /** Brand-name hint from package.json (scope stripped), when present. */
  brandName?: string;
  /** Hex colors found in the Tailwind config / CSS custom properties. */
  colors: string[];
  /** Font-family names found in the Tailwind config / CSS. */
  fonts: string[];
  /** Corner-radius hints (px / rem values) from CSS custom properties. */
  radii: string[];
  /** Relevant dependencies detected in package.json. */
  packages: string[];
  /** True when a dark-mode fingerprint was found (`.dark` class, media query, next-themes). */
  darkMode: boolean;
  /** Human-readable one-line brief for prompt injection. */
  brief: string;
}

/** Options for {@link analyzeDesignContext}. */
export interface AnalyzeDesignContextOptions {
  /**
   * Upper bound on CSS/SCSS files scanned. Keeps a monorepo workspace
   * from stalling the stdio loop. Default 40.
   */
  maxFiles?: number;
  /**
   * Upper bound on bytes read per file. Config files are tiny; this
   * guard only matters for a pathological minified bundle. Default
   * 262 144 (256 KiB).
   */
  maxFileBytes?: number;
  /** Injectable fs read for tests. Defaults to `fs/promises.readFile`. */
  readFile?: (p: string) => Promise<string>;
  /** Injectable file-existence probe for tests. Defaults to `fs.existsSync`. */
  exists?: (p: string) => boolean;
  /**
   * Injectable directory listing for tests. Defaults to
   * `fsSync.readdirSync(p, { withFileTypes: true })`.
   */
  readdir?: (p: string) => Array<{ name: string; isDirectory(): boolean }>;
}

// ─── Bounds ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const MAX_COLORS = 24;
const MAX_FONTS = 8;
const MAX_RADII = 8;
const MAX_PACKAGES = 16;

/** Directories scanned for CSS / SCSS sources (relative to workspace root). */
const CSS_SCAN_DIRS = ['src', 'styles', 'app', 'assets', 'css'] as const;

/** Package-name fragments that fingerprint the design stack. */
const STACK_PACKAGES = [
  'tailwindcss',
  'next',
  'nuxt',
  '@nuxtjs',
  'svelte',
  'vue',
  'react',
  'angular',
  '@shadcn',
  'shadcn',
  '@chakra-ui',
  '@mantine',
  'antd',
  '@mui',
  'styled-components',
  '@emotion',
  'sass',
  'less',
  'framer-motion',
  'next-themes',
  'daisyui',
  'radix-ui',
] as const;

// ─── Analyzer ──────────────────────────────────────────────────────────────

/**
 * Analyze the workspace's design system. Never throws: every step is
 * individually guarded and a totally unreadable workspace resolves to a
 * minimal context with `framework: 'unknown'`.
 */
export async function analyzeDesignContext(
  workspaceRoot: string,
  opts: AnalyzeDesignContextOptions = {},
): Promise<DesignContext> {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const readFile = opts.readFile ?? defaultReadFile;
  const exists = opts.exists ?? ((p: string): boolean => fsSync.existsSync(p));
  const readdir =
    opts.readdir ??
    ((p: string): Array<{ name: string; isDirectory(): boolean }> =>
      fsSync.readdirSync(p, { withFileTypes: true }));

  const colors = new Set<string>();
  const fonts = new Set<string>();
  const radii = new Set<string>();
  const packages = new Set<string>();

  let brandName: string | undefined;
  let darkMode = false;

  // Step 1: package.json — stack fingerprint + brand hint.
  const pkgJson = path.join(workspaceRoot, 'package.json');
  if (exists(pkgJson)) {
    try {
      const raw = await readBounded(readFile, pkgJson, maxFileBytes);
      const parsed = JSON.parse(raw) as {
        name?: unknown;
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      if (typeof parsed.name === 'string' && parsed.name.trim().length > 0) {
        // Strip npm scope so `@acme/web` reads as the brand `web`.
        brandName = parsed.name.replace(/^@[^/]+\//, '').trim();
      }
      const depNames = [
        ...Object.keys(parsed.dependencies ?? {}),
        ...Object.keys(parsed.devDependencies ?? {}),
      ];
      for (const dep of depNames) {
        for (const fragment of STACK_PACKAGES) {
          if (dep === fragment || dep.startsWith(fragment)) {
            if (packages.size < MAX_PACKAGES) packages.add(fragment);
            break;
          }
        }
        if (dep === 'next-themes' || dep === '@next/theming') darkMode = true;
      }
    } catch {
      // Malformed package.json — continue with what we have.
    }
  }

  // Step 2: Tailwind config — colors + fonts (text regex, never eval).
  const tailwindConfig = findFirstExisting(
    exists,
    workspaceRoot,
    ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'tailwind.config.mjs'],
  );
  if (tailwindConfig !== null) {
    try {
      const raw = await readBounded(readFile, tailwindConfig, maxFileBytes);
      extractColors(raw, colors);
      extractFontFamilies(raw, fonts);
      if (/darkMode['"]?\s*[:=]\s*['"]class['"]/.test(raw)) darkMode = true;
    } catch {
      // Unreadable config — continue.
    }
  }

  // Step 3: CSS / SCSS sources — custom properties + font-family.
  const cssFiles = await collectCssFiles(workspaceRoot, exists, readdir, maxFiles);
  for (const file of cssFiles) {
    try {
      const raw = await readBounded(readFile, file, maxFileBytes);
      extractCssVariables(raw, colors, radii);
      extractFontFamilies(raw, fonts);
      if (/\.dark\b|prefers-color-scheme:\s*dark/.test(raw)) darkMode = true;
    } catch {
      // Unreadable file — skip.
    }
  }

  // Step 4: framework fingerprint from config-file presence.
  const framework = detectFrameworkFingerprint(exists, workspaceRoot, packages);

  const ctx: DesignContext = {
    framework,
    colors: [...colors].slice(0, MAX_COLORS),
    fonts: [...fonts].slice(0, MAX_FONTS),
    radii: [...radii].slice(0, MAX_RADII),
    packages: [...packages],
    darkMode,
    brief: '',
  };
  if (brandName !== undefined) ctx.brandName = brandName;
  ctx.brief = describeDesignContext(ctx);
  return ctx;
}

/**
 * Render a {@link DesignContext} as a compact single-line design brief
 * suitable for appending to a generation prompt. Bounded to ~400 chars
 * so prompt-composition keeps predictable headroom under the 4000-char
 * wire budget.
 */
export function describeDesignContext(ctx: DesignContext): string {
  const parts: string[] = [];

  if (ctx.brandName !== undefined) {
    parts.push(`brand "${ctx.brandName}"`);
  }
  const stackParts =
    ctx.framework === 'unknown' ? [...ctx.packages] : [ctx.framework, ...ctx.packages];
  if (stackParts.length > 0) {
    parts.push(`stack ${stackParts.join(' + ')}`);
  }
  if (ctx.colors.length > 0) {
    parts.push(`palette ${ctx.colors.slice(0, 6).join(', ')}`);
  }
  if (ctx.fonts.length > 0) {
    parts.push(`typeface ${ctx.fonts.slice(0, 3).join(', ')}`);
  }
  if (ctx.radii.length > 0) {
    parts.push(`corner radius ${ctx.radii[0]}`);
  }
  if (ctx.darkMode) {
    parts.push('dark-mode aware');
  }

  if (parts.length === 0) return '';
  return `Match the project design system (${parts.join('; ')}).`;
}

// ─── Extraction helpers (all pure, exported for tests) ─────────────────────

/** Extract hex / rgb() color literals from arbitrary config text. */
export function extractColors(text: string, sink: Set<string>): void {
  const hexRe = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
  const rgbRe = /\brgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+)\s*)?\s*\)/g;
  for (const m of text.matchAll(hexRe)) {
    if (sink.size >= MAX_COLORS) return;
    sink.add(normalizeHex(m[0]));
  }
  for (const m of text.matchAll(rgbRe)) {
    if (sink.size >= MAX_COLORS) return;
    sink.add(m[0].replace(/\s+/g, ''));
  }
}

/**
 * Extract CSS custom-property colors and radii
 * (`--color-primary: #0f172a;`, `--radius: 0.75rem;`).
 */
export function extractCssVariables(
  text: string,
  colorSink: Set<string>,
  radiusSink: Set<string>,
): void {
  const varRe = /--[\w-]+\s*:\s*([^;]+);/g;
  for (const m of text.matchAll(varRe)) {
    const value = (m[1] ?? '').trim();
    const name = (m[0].match(/--[\w-]+/)?.[0] ?? '').toLowerCase();
    if (value.length === 0) continue;
    if (name.includes('radius')) {
      if (radiusSink.size < MAX_RADII) radiusSink.add(value);
      continue;
    }
    if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) {
      if (colorSink.size < MAX_COLORS) colorSink.add(normalizeHex(value));
      continue;
    }
    if (/^rgba?\(/i.test(value) && colorSink.size < MAX_COLORS) {
      colorSink.add(value.replace(/\s+/g, ''));
    }
  }
}

/** Extract font-family names from config or CSS text. */
export function extractFontFamilies(text: string, sink: Set<string>): void {
  // Tailwind-style: fontFamily: { sans: ['Inter', ...] } — capture the
  // first quoted token of each array.
  const quotedRe = /['"]([^'"]+)['"]/g;
  const blockMatch = /fontFamily\s*:\s*\{([\s\S]{0,600}?)\}/.exec(text);
  if (blockMatch !== null) {
    for (const m of (blockMatch[1] ?? '').matchAll(quotedRe)) {
      const name = m[1] ?? '';
      if (isGenericFamily(name)) continue;
      if (sink.size >= MAX_FONTS) return;
      sink.add(name);
    }
  }
  // CSS-style: font-family: Inter, system-ui, sans-serif;
  const cssRe = /font-family\s*:\s*([^;}]+)/gi;
  for (const m of text.matchAll(cssRe)) {
    for (const token of (m[1] ?? '').split(',')) {
      const name = token.trim().replace(/^['"]|['"]$/g, '');
      if (name.length === 0 || isGenericFamily(name)) continue;
      if (sink.size >= MAX_FONTS) return;
      sink.add(name);
    }
  }
}

// ─── Internals ─────────────────────────────────────────────────────────────

async function defaultReadFile(p: string): Promise<string> {
  return fsp.readFile(p, 'utf8');
}

/** Read a file, refusing anything larger than `maxBytes`. */
async function readBounded(
  readFile: (p: string) => Promise<string>,
  p: string,
  maxBytes: number,
): Promise<string> {
  const raw = await readFile(p);
  if (raw.length > maxBytes) return raw.slice(0, maxBytes);
  return raw;
}

/** Return the first of `names` that exists under `root`, or `null`. */
function findFirstExisting(
  exists: (p: string) => boolean,
  root: string,
  names: readonly string[],
): string | null {
  for (const name of names) {
    const p = path.join(root, name);
    if (exists(p)) return p;
  }
  return null;
}

/**
 * Collect a bounded list of CSS / SCSS files under the conventional
 * source directories. Shallow walk (depth ≤ 3) to stay cheap.
 */
async function collectCssFiles(
  root: string,
  exists: (p: string) => boolean,
  readdir: (p: string) => Array<{ name: string; isDirectory(): boolean }>,
  maxFiles: number,
): Promise<string[]> {
  const out: string[] = [];
  for (const dir of CSS_SCAN_DIRS) {
    if (out.length >= maxFiles) break;
    const base = path.join(root, dir);
    if (!exists(base)) continue;
    await walkCss(base, 0, out, maxFiles, readdir);
  }
  return out;
}

async function walkCss(
  dir: string,
  depth: number,
  out: string[],
  maxFiles: number,
  readdir: (p: string) => Array<{ name: string; isDirectory(): boolean }>,
): Promise<void> {
  if (depth > 3 || out.length >= maxFiles) return;
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkCss(full, depth + 1, out, maxFiles, readdir);
    } else if (/\.(css|scss|sass)$/i.test(entry.name)) {
      out.push(full);
    }
  }
}

/**
 * Framework fingerprint from config files, refined by detected packages
 * (e.g. `next` in package.json even without a root next.config).
 */
function detectFrameworkFingerprint(
  exists: (p: string) => boolean,
  root: string,
  packages: ReadonlySet<string>,
): Framework {
  if (
    exists(path.join(root, 'next.config.js')) ||
    exists(path.join(root, 'next.config.mjs')) ||
    exists(path.join(root, 'next.config.ts'))
  ) {
    return 'next';
  }
  if (exists(path.join(root, 'nuxt.config.ts')) || exists(path.join(root, 'nuxt.config.js'))) {
    return 'nuxt';
  }
  if (exists(path.join(root, 'svelte.config.js')) || exists(path.join(root, 'src', 'routes'))) {
    return 'sveltekit';
  }
  if (exists(path.join(root, 'angular.json'))) return 'angular';
  if (
    exists(path.join(root, 'vite.config.ts')) ||
    exists(path.join(root, 'vite.config.js'))
  ) {
    return 'vite';
  }
  if (packages.has('next')) return 'next';
  if (packages.has('nuxt') || packages.has('@nuxtjs')) return 'nuxt';
  if (packages.has('svelte')) return 'sveltekit';
  if (packages.has('angular')) return 'angular';
  if (packages.has('react')) return 'cra';
  return 'unknown';
}

/** Normalize a hex color to lowercase 6-digit form where possible. */
function normalizeHex(raw: string): string {
  const lower = raw.toLowerCase();
  if (/^#[0-9a-f]{4}$/.test(lower)) {
    // #abcd → #aabbccdd (expand the 4-digit form).
    const [, a, b, c, d] = lower;
    return `#${a}${a}${b}${b}${c}${c}${d}${d}`;
  }
  if (/^#[0-9a-f]{3}$/.test(lower)) {
    const [, r, g, b] = lower;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return lower;
}

/** True for CSS generic families that carry no brand identity. */
function isGenericFamily(name: string): boolean {
  return /^(system-ui|sans-serif|serif|monospace|cursive|fantasy|ui-[a-z]+|inherit|initial|unset|-apple-system|segoe ui|roboto|helvetica|arial)$/i.test(
    name,
  );
}
