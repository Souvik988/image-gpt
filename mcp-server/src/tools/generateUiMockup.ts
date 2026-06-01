/**
 * MCP tool handler: `generate_ui_mockup`.
 *
 * Implements R31.3 (UI mockup tool), R31.4 (template-built prompt), R31.6
 * (success shape), R31.7 (closed-enum error codes; no file write on
 * failure).
 *
 * Accepted arguments:
 *   - component_description  (string, required)
 *   - viewport               (string, optional, default 'desktop 1440x900')
 *   - framework              (Framework, default 'unknown')
 *   - workspace_root         (string, overrides KIRO_GPT_MCP_WORKSPACE)
 *   - overwrite              (boolean, default false)
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

/** Arguments for `generate_ui_mockup`. */
export interface GenerateUiMockupArgs {
  component_description?: unknown;
  viewport?: unknown;
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
 * Run the `generate_ui_mockup` tool. Implements R31.3 (mockup), R31.4,
 * R31.6, R31.7.
 */
export async function generateUiMockup(
  args: GenerateUiMockupArgs | undefined,
  ctx: McpToolContext,
): Promise<McpImageResult> {
  const a = args ?? {};

  if (
    typeof a.component_description !== 'string' ||
    a.component_description.trim().length === 0
  ) {
    return fail(
      'INVALID_PROMPT',
      'component_description is required and must be a non-empty string',
    );
  }
  const viewport = typeof a.viewport === 'string' ? a.viewport : undefined;

  const templated = PROMPT_TEMPLATES.uiMockup(a.component_description, viewport);
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
    kind: 'ui',
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
    assetCategory: 'mockup',
    prompt: a.component_description,
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
    assetCategory: 'mockup',
  };
}
