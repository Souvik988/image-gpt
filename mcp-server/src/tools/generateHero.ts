/**
 * MCP tool handler: `generate_hero`.
 *
 * Implements R31.3 (hero tool), R31.4 (template-built prompt), R31.6
 * (success shape), R31.7 (closed-enum error codes; no file write on
 * failure).
 *
 * Accepted arguments:
 *   - scene_description  (string, required)
 *   - aspect_ratio       (string, optional, default 16:9)
 *   - framework          (Framework, default 'unknown')
 *   - workspace_root     (string, overrides KIRO_GPT_MCP_WORKSPACE)
 *   - overwrite          (boolean, default false)
 */

import { PROMPT_TEMPLATES } from '../promptTemplates.js';
import {
  atomicWrite,
  coerceEnhancePromptFlag,
  coerceFramework,
  decodeFinalChunk,
  ensureConnected,
  fail,
  prepareImagePrompt,
  resolveTargetPath,
  tryResolveWorkspace,
  validateImagePrompt,
  submitImageRequest,
  type McpImageResult,
  type McpToolContext,
} from './common.js';
import { lookupCachedAsset, recordCachedAsset } from '../assetCache.js';
import { analyzeDesignContext } from '../designContext.js';

/** Arguments for `generate_hero`. */
export interface GenerateHeroArgs {
  scene_description?: unknown;
  aspect_ratio?: unknown;
  framework?: unknown;
  workspace_root?: unknown;
  overwrite?: unknown;
  /** Opt out of the content-addressed asset cache for this call. */
  cache?: unknown;
  /**
   * Opt in to the LLM-rewrite pre-stage for this call. See
   * {@link enhancePrompt} for behaviour and failure semantics.
   */
  enhance_prompt?: unknown;
}

/**
 * Run the `generate_hero` tool. Implements R31.3 (hero), R31.4, R31.6,
 * R31.7.
 */
export async function generateHero(
  args: GenerateHeroArgs | undefined,
  ctx: McpToolContext,
): Promise<McpImageResult> {
  const a = args ?? {};

  if (
    typeof a.scene_description !== 'string' ||
    a.scene_description.trim().length === 0
  ) {
    return fail(
      'INVALID_PROMPT',
      'scene_description is required and must be a non-empty string',
    );
  }
  const aspectRatio =
    typeof a.aspect_ratio === 'string' ? a.aspect_ratio : undefined;

  const templated = PROMPT_TEMPLATES.hero(a.scene_description, aspectRatio);
  const promptCheck = validateImagePrompt(templated);
  if (promptCheck.ok !== true) return promptCheck;

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

  // UI understanding: append the workspace's design-system brief when
  // readable so the asset inherits the project's palette / typography.
  let designBrief = '';
  try {
    const design = await analyzeDesignContext(ws.workspaceRoot);
    designBrief = design.brief;
  } catch {
    /* best effort — proceed without design context */
  }
  const withDesign =
    designBrief.length > 0 ? `${templated} ${designBrief}` : templated;

  const enhanced = prepareImagePrompt({
    templated: withDesign,
    kind: 'hero',
    perCallOptIn: enhanceOptIn,
  });
  const enhancedCheck = validateImagePrompt(enhanced.prompt);
  if (enhancedCheck.ok !== true) return enhancedCheck;
  const prompt = enhanced.prompt;

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
    prompt: a.scene_description,
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
