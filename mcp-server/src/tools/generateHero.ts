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
  buildImageRequest,
  coerceEnhancePromptFlag,
  coerceFramework,
  decodeFinalChunk,
  ensureConnected,
  fail,
  mapRelayError,
  prepareImagePrompt,
  resolveTargetPath,
  tryResolveWorkspace,
  validateImagePrompt,
  type McpImageResult,
  type McpToolContext,
} from './common.js';

/** Arguments for `generate_hero`. */
export interface GenerateHeroArgs {
  scene_description?: unknown;
  aspect_ratio?: unknown;
  framework?: unknown;
  workspace_root?: unknown;
  overwrite?: unknown;
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

  const connErr = ensureConnected(ctx);
  if (connErr !== null) return connErr;

  const ws = tryResolveWorkspace(ctx, workspaceArg);
  if (ws.ok !== true) return ws;

  const enhanced = prepareImagePrompt({
    templated,
    kind: 'hero',
    perCallOptIn: enhanceOptIn,
  });
  const enhancedCheck = validateImagePrompt(enhanced.prompt);
  if (enhancedCheck.ok !== true) return enhancedCheck;
  const prompt = enhanced.prompt;

  const request = buildImageRequest(prompt);
  let finalChunk;
  try {
    finalChunk = await ctx.relayClient.submitAndAwait(request);
  } catch (err) {
    return mapRelayError(err);
  }

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

  return {
    ok: true,
    savedPath: target.absolutePath,
    mimeType: decoded.mimeType,
    prompt,
    requestId: request.requestId,
    assetCategory: 'hero',
  };
}
