/**
 * MCP tool handler: `generate_logo`.
 *
 * Implements R31.3 (logo tool), R31.4 (template-built prompt), R31.6
 * (success shape), R31.7 (closed-enum error codes; no file write on
 * failure).
 *
 * Accepted arguments:
 *   - brand_name      (string, required, 1–4000 chars after templating)
 *   - style           (string, optional)
 *   - color_palette   (string, optional)
 *   - framework       (Framework, default 'unknown')
 *   - workspace_root  (string, overrides KIRO_GPT_MCP_WORKSPACE)
 *   - overwrite       (boolean, default false)
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

/** Arguments for `generate_logo`. */
export interface GenerateLogoArgs {
  brand_name?: unknown;
  style?: unknown;
  color_palette?: unknown;
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
 * Run the `generate_logo` tool. Implements R31.3 (logo), R31.4, R31.6,
 * R31.7.
 */
export async function generateLogo(
  args: GenerateLogoArgs | undefined,
  ctx: McpToolContext,
): Promise<McpImageResult> {
  const a = args ?? {};

  if (typeof a.brand_name !== 'string' || a.brand_name.trim().length === 0) {
    return fail('INVALID_PROMPT', 'brand_name is required and must be a non-empty string');
  }
  const style = typeof a.style === 'string' ? a.style : undefined;
  const palette =
    typeof a.color_palette === 'string' ? a.color_palette : undefined;

  const templated = PROMPT_TEMPLATES.logo(a.brand_name, style, palette);
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
    kind: 'logo',
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
    assetCategory: 'logo',
    prompt: a.brand_name,
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
    assetCategory: 'logo',
  };
}
