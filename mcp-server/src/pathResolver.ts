/**
 * Pure path-resolution and slug helpers for the MCP server.
 *
 * Duplicated from `kiro-extension/src/assets/pathResolver.ts` so the MCP
 * server is independently runnable as a standalone Node process; the
 * modules are tiny and the duplication keeps the two packages from
 * importing across deploy boundaries.
 *
 * Implements R30.1 (framework enum), R30.2 (base directory + category
 * subfolder mapping), R30.3 (slugify rules: lowercase ASCII a–z 0–9 and
 * hyphens, collapsed hyphens, no leading/trailing hyphen, first 40 chars
 * of the prompt). The MCP server consumes these helpers via the five
 * tool handlers in `src/tools/` to derive an absolute target path under
 * the workspace root for each generated asset.
 */

import * as path from 'node:path';

import type { AssetCategory } from '@kiro-gpt-bridge/shared';

// ─── Closed enums ──────────────────────────────────────────────────────────

/**
 * Frontend frameworks the path resolver knows about. Implements R30.1.
 *
 * The literal union is closed; passing any other value to {@link resolvePath}
 * is a TypeScript error and a runtime fallback to `unknown` semantics.
 */
export const FRAMEWORKS = [
  'next',
  'nuxt',
  'sveltekit',
  'vite',
  'angular',
  'cra',
  'unknown',
] as const;

/** Literal union derived from {@link FRAMEWORKS}. */
export type Framework = typeof FRAMEWORKS[number];

/**
 * MIME types the resolver knows how to translate into file extensions.
 * Mirrors the closed enum on `StreamChunk.mediaType` from the shared
 * wire schema.
 */
export type ImageMimeType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif';

// ─── Mapping tables ────────────────────────────────────────────────────────

/**
 * Base directory under the workspace root keyed by framework.
 * Implements R30.2.
 */
const BASE_DIR_BY_FRAMEWORK: Readonly<Record<Framework, string>> = {
  next: 'public',
  nuxt: 'public',
  vite: 'public',
  cra: 'public',
  sveltekit: 'static',
  angular: path.join('src', 'assets'),
  unknown: 'assets',
};

/**
 * Subfolder under the base directory keyed by asset category.
 * Implements R30.2. The `other` category resolves to the empty string
 * so the file lands directly under the framework base directory.
 */
const SUBDIR_BY_CATEGORY: Readonly<Record<AssetCategory, string>> = {
  logo: 'logo',
  hero: 'hero',
  icon: 'icons',
  illustration: 'illustrations',
  background: 'backgrounds',
  mockup: 'mockups',
  other: '',
};

/**
 * Canonical file extension keyed by MIME type. `image/jpeg` → `.jpg`
 * matches the convention used by the extension's saveImage flow.
 */
const EXT_BY_MIME: Readonly<Record<ImageMimeType, '.png' | '.jpg' | '.webp' | '.gif'>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

// ─── Pure helpers ──────────────────────────────────────────────────────────

/**
 * Slugify a free-form prompt into a filesystem-safe filename stem.
 *
 * Rules (R30.3):
 *  - Take the first `maxLen` characters of the input.
 *  - Lowercase.
 *  - Replace any run of non-`[a-z0-9]` characters with a single hyphen.
 *  - Trim leading and trailing hyphens.
 *
 * Returns the literal string `image` when the slug would otherwise be
 * empty (e.g. all-whitespace prompt) so a caller never has to handle a
 * blank stem.
 *
 * @param prompt The prompt text or any free-form string.
 * @param maxLen Maximum input window before slugification. Default 40.
 */
export function slugify(prompt: string, maxLen: number = 40): string {
  const window = prompt.slice(0, maxLen).toLowerCase();
  const replaced = window.replace(/[^a-z0-9]+/g, '-');
  const trimmed = replaced.replace(/^-+|-+$/g, '');
  return trimmed.length > 0 ? trimmed : 'image';
}

/**
 * Map a {@link ImageMimeType} to its conventional extension.
 *
 * Implements R30.3 (filename derivation appends the MIME-matching
 * extension).
 */
export function extensionForMime(mime: ImageMimeType): '.png' | '.jpg' | '.webp' | '.gif' {
  return EXT_BY_MIME[mime];
}

// ─── resolvePath ───────────────────────────────────────────────────────────

/** Inputs accepted by {@link resolvePath}. */
export interface ResolvePathInput {
  /** Absolute path of the workspace root the file lands under. */
  workspaceRoot: string;
  /** Detected (or user-supplied) frontend framework. */
  framework: Framework;
  /** Asset category that selects the subfolder under the base directory. */
  assetCategory: AssetCategory;
  /**
   * Filename including extension. Caller is responsible for slugifying
   * the stem and appending the MIME-matching extension via
   * {@link slugify} + {@link extensionForMime}.
   */
  filename: string;
}

/**
 * Compute the absolute target path for a generated asset under the
 * workspace root. Pure; deterministic; never touches the filesystem.
 *
 * Implements R30.2.
 *
 * @param input See {@link ResolvePathInput}.
 * @returns The absolute path the asset should be written to.
 */
export function resolvePath(input: ResolvePathInput): string {
  const baseDir: string = BASE_DIR_BY_FRAMEWORK[input.framework];
  const subDir: string = SUBDIR_BY_CATEGORY[input.assetCategory];
  // Paths are joined with `path.join` so platform separators are normal.
  // `subDir` may be the empty string for `other`, in which case
  // path.join just elides it.
  return path.join(input.workspaceRoot, baseDir, subDir, input.filename);
}
