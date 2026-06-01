/**
 * MCP tool handler: `generate_image`.
 *
 * Implements R31.3 (generic image tool), R31.4 (template-built prompt
 * forwarded as an image Request to the relay), R31.6 (success result
 * shape), R31.7 (closed-enum error codes; never write on failure).
 *
 * Accepted arguments (all optional except `prompt`):
 *   - prompt          (string, 1–4000 chars, required)
 *   - asset_category  (AssetCategory, default 'other')
 *   - filename        (string, optional; stem auto-derived from prompt)
 *   - framework       (Framework, default 'unknown')
 *   - workspace_root  (string, overrides KIRO_GPT_MCP_WORKSPACE)
 *   - overwrite       (boolean, default false)
 */

import { PROMPT_TEMPLATES } from '../promptTemplates.js';
import {
  atomicWrite,
  buildImageRequest,
  coerceAssetCategory,
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

/**
 * Arguments accepted by `generate_image`. Every field is `unknown` at
 * the type boundary because the MCP SDK forwards arbitrary client args.
 */
export interface GenerateImageArgs {
  prompt?: unknown;
  asset_category?: unknown;
  filename?: unknown;
  framework?: unknown;
  workspace_root?: unknown;
  overwrite?: unknown;
  /**
   * Opt in to the LLM-rewrite pre-stage for this call. When `true`,
   * the templated prompt is run through ChatGPT itself and expanded
   * into a higher-quality DALL-E prompt before image generation.
   * Adds one chat round-trip (~5–15 s); falls back to the templated
   * prompt on any rewrite failure (R31.7).
   */
  enhance_prompt?: unknown;
}

/**
 * Run the `generate_image` tool. See module doc for argument shape.
 *
 * Implements R31.3, R31.4, R31.6, R31.7.
 */
export async function generateImage(
  args: GenerateImageArgs | undefined,
  ctx: McpToolContext,
): Promise<McpImageResult> {
  const a = args ?? {};

  // Validate prompt up-front.
  if (typeof a.prompt !== 'string') {
    return fail('INVALID_PROMPT', 'prompt is required and must be a string');
  }
  const promptCheck = validateImagePrompt(a.prompt);
  if (promptCheck.ok !== true) return promptCheck;

  // Build the prompt via the (identity) template so prompt construction
  // stays uniform across tools.
  const templated = PROMPT_TEMPLATES.generic(a.prompt);
  const assetCategory = coerceAssetCategory(a.asset_category, 'other');
  const framework = coerceFramework(a.framework);
  const overwrite = a.overwrite === true;
  const filename =
    typeof a.filename === 'string' && a.filename.length > 0
      ? a.filename
      : undefined;
  const workspaceArg =
    typeof a.workspace_root === 'string' ? a.workspace_root : undefined;
  const enhanceOptIn = coerceEnhancePromptFlag(a.enhance_prompt);

  // R31.7: short-circuit on disconnected relay before any side effects.
  const connErr = ensureConnected(ctx);
  if (connErr !== null) return connErr;

  const ws = tryResolveWorkspace(ctx, workspaceArg);
  if (ws.ok !== true) return ws;

  // Optional rewrite pre-stage. Falls back to `templated` on failure.
  const enhanced = prepareImagePrompt({
    templated,
    kind: 'generic',
    perCallOptIn: enhanceOptIn,
  });
  // The rewrite output may exceed the templated length — re-validate
  // against the 4000-char wire limit before submitting.
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
    assetCategory,
    filename,
    prompt,
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
    assetCategory,
  };
}
