/**
 * MCP tool handler: `generate_banner`.
 *
 * Phase 3 asset tool — website banner / ad-unit graphics with closed
 * size presets. The size preset is injected into the composed prompt as
 * an aspect directive so ChatGPT's image tool frames the composition
 * correctly.
 *
 * Accepted arguments:
 *   - description      (string, required)
 *   - size             (string, optional — closed preset map, default
 *                      `leaderboard`)
 *   - style            (string, optional extra style directive)
 *   - framework        (Framework, default 'unknown')
 *   - workspace_root   (string, overrides KIRO_GPT_MCP_WORKSPACE)
 *   - overwrite        (boolean, default false)
 *   - enhance_prompt   (boolean, opt-in single-turn rewrite)
 */

import {
  composePrompt,
} from '../promptComposer.js';
import { analyzeDesignContext } from '../designContext.js';
import {
  atomicWrite,
  coerceEnhancePromptFlag,
  coerceFramework,
  decodeFinalChunk,
  ensureConnected,
  fail,
  resolveTargetPath,
  tryResolveWorkspace,
  validateImagePrompt,
  submitImageRequest,
  type McpImageResult,
  type McpToolContext,
} from './common.js';
import { lookupCachedAsset, recordCachedAsset } from '../assetCache.js';

/** Closed size presets for `generate_banner`. */
export const BANNER_SIZES = {
  leaderboard: { width: 728, height: 90, label: 'leaderboard 728x90' },
  medium_rectangle: { width: 300, height: 250, label: 'medium rectangle 300x250' },
  wide_skyscraper: { width: 160, height: 600, label: 'wide skyscraper 160x600' },
  billboard: { width: 970, height: 250, label: 'billboard 970x250' },
  hero_wide: { width: 1600, height: 500, label: 'wide hero banner 1600x500' },
} as const;

/** Literal union of the banner size presets. */
export type BannerSize = keyof typeof BANNER_SIZES;

/** Arguments for `generate_banner`. */
export interface GenerateBannerArgs {
  description?: unknown;
  size?: unknown;
  style?: unknown;
  framework?: unknown;
  workspace_root?: unknown;
  overwrite?: unknown;
  /** Opt out of the content-addressed asset cache for this call. */
  cache?: unknown;
  enhance_prompt?: unknown;
}

/** Narrow an arbitrary value to a {@link BannerSize}. */
export function coerceBannerSize(value: unknown): BannerSize {
  if (typeof value === 'string' && value in BANNER_SIZES) {
    return value as BannerSize;
  }
  return 'leaderboard';
}

/**
 * Run the `generate_banner` tool. Banners land under the framework's
 * `hero/` category folder (banner graphics are hero-adjacent surface).
 */
export async function generateBanner(
  args: GenerateBannerArgs | undefined,
  ctx: McpToolContext,
): Promise<McpImageResult> {
  const a = args ?? {};

  if (typeof a.description !== 'string' || a.description.trim().length === 0) {
    return fail('INVALID_PROMPT', 'description is required and must be a non-empty string');
  }
  const size = coerceBannerSize(a.size);
  const preset = BANNER_SIZES[size];
  const style = typeof a.style === 'string' ? a.style : undefined;

  const framework = coerceFramework(a.framework);
  const overwrite = a.overwrite === true;
  const workspaceArg =
    typeof a.workspace_root === 'string' ? a.workspace_root : undefined;
  const enhanceOptIn = coerceEnhancePromptFlag(a.enhance_prompt);
  const useCache = a.cache !== false;

  const connErr = ensureConnected(ctx);
  if (connErr !== null) return connErr;

  const ws = tryResolveWorkspace(ctx, workspaceArg);
  if (ws.ok !== true) return ws;

  // UI understanding: inject the project's design system when readable.
  const design = await analyzeDesignContext(ws.workspaceRoot);
  const aspect = `Aspect ratio ${preset.width}:${preset.height} (${preset.label}).`;

  const prompt = composePrompt({
    kind: 'banner',
    specifics: `${a.description} ${aspect}`,
    design,
    style,
  });
  const promptCheck = validateImagePrompt(prompt);
  if (promptCheck.ok !== true) return promptCheck;

  // Asset cache (Phase 4): identical prompt + unchanged design system
  // means the generation round-trip can be skipped entirely.
  if (useCache) {
    const cached = await lookupCachedAsset(ws.workspaceRoot, prompt);
    if (cached !== null) {
      return {
        ok: true,
        savedPath: cached.savedPath,
        mimeType: cached.mimeType,
        prompt,
        requestId: `cached-${cached.hash}`,
        assetCategory: 'hero',
      };
    }
  }

  // Submit with the content-policy rephrase safety net (Phase 5).
  const submitted = await submitImageRequest(ctx, prompt);
  if (submitted.ok !== true) return submitted;
  const finalChunk = submitted.finalChunk;
  const promptUsed = submitted.promptUsed;
  const requestId = submitted.requestId;

  const decoded = decodeFinalChunk(finalChunk);
  if (decoded.ok !== true) return decoded;

  const target = await resolveTargetPath({
    workspaceRoot: ws.workspaceRoot,
    framework,
    assetCategory: 'hero',
    prompt: a.description,
    mimeType: decoded.mimeType,
    overwrite,
  });
  if (target.ok !== true) return target;

  try {
    await atomicWrite(target.absolutePath, decoded.bytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail('CHATGPT_UNAVAILABLE', `write failed: ${message}`);
  }

  if (useCache) {
    await recordCachedAsset(ws.workspaceRoot, prompt, target.absolutePath, decoded.mimeType);
  }

  return {
    ok: true,
    savedPath: target.absolutePath,
    mimeType: decoded.mimeType,
    prompt: promptUsed,
    requestId,
    assetCategory: 'hero',
  };
}
