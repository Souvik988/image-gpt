/**
 * MCP tool handler: `generate_og_image`.
 *
 * Phase 3 asset tool — Open Graph / social-card image at the canonical
 * 1200x630 size. The composition keeps the left third headline-safe
 * because the caller overlays real text in code (the negative anchors
 * forbid embedded text, which image models render as garbled glyphs).
 *
 * Accepted arguments:
 *   - description      (string, required)
 *   - style            (string, optional extra style directive)
 *   - framework        (Framework, default 'unknown')
 *   - workspace_root   (string, overrides KIRO_GPT_MCP_WORKSPACE)
 *   - overwrite        (boolean, default false)
 *   - enhance_prompt   (boolean, opt-in single-turn rewrite)
 */

import { composePrompt } from '../promptComposer.js';
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

/** Arguments for `generate_og_image`. */
export interface GenerateOgImageArgs {
  description?: unknown;
  style?: unknown;
  framework?: unknown;
  workspace_root?: unknown;
  overwrite?: unknown;
  /** Opt out of the content-addressed asset cache for this call. */
  cache?: unknown;
  enhance_prompt?: unknown;
}

/**
 * Run the `generate_og_image` tool. Files land in the framework's base
 * directory (the `other` category) with an `og-` filename stem so the
 * card is easy to reference from `<meta property="og:image">`.
 */
export async function generateOgImage(
  args: GenerateOgImageArgs | undefined,
  ctx: McpToolContext,
): Promise<McpImageResult> {
  const a = args ?? {};

  if (typeof a.description !== 'string' || a.description.trim().length === 0) {
    return fail('INVALID_PROMPT', 'description is required and must be a non-empty string');
  }
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

  const design = await analyzeDesignContext(ws.workspaceRoot);
  const aspect = 'Social card 1200x630, left third reserved as headline-safe negative space.';

  const prompt = composePrompt({
    kind: 'og',
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
        assetCategory: 'other',
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
    assetCategory: 'other',
    filename: 'og-image',
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
    assetCategory: 'other',
  };
}
