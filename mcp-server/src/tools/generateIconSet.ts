/**
 * MCP tool handler: `generate_icon_set`.
 *
 * Implements R31.3 (icon set tool — array of names sharing a theme),
 * R31.4 (template-built prompts), R31.6 (success shape with
 * `savedPaths: string[]`), R31.7 (closed-enum error codes; no file
 * writes on failure).
 *
 * Accepted arguments:
 *   - theme           (string, required)
 *   - names           (string[], required, length >= 1)
 *   - style           (string, optional)
 *   - framework       (Framework, default 'unknown')
 *   - workspace_root  (string, overrides KIRO_GPT_MCP_WORKSPACE)
 *   - overwrite       (boolean, default false)
 *
 * Each name produces one icon. Generation is sequential (one Request at
 * a time) so a single browser-agent does not have to multiplex parallel
 * image requests, matching the "in series" pattern used by the
 * extension's `generateMissingAssets` command.
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
  type McpIconSetResult,
  type McpToolContext,
} from './common.js';
import type { ImageMimeType } from '../pathResolver.js';

/** Arguments for `generate_icon_set`. */
export interface GenerateIconSetArgs {
  theme?: unknown;
  names?: unknown;
  style?: unknown;
  framework?: unknown;
  workspace_root?: unknown;
  overwrite?: unknown;
  /**
   * Opt in to the LLM-rewrite pre-stage for this call. When `true`,
   * EACH icon's prompt is run through the rewrite. See
   * {@link enhancePrompt} for behaviour and failure semantics.
   */
  enhance_prompt?: unknown;
}

/**
 * Run the `generate_icon_set` tool. Implements R31.3 (icon set), R31.4,
 * R31.6, R31.7.
 *
 * On any per-icon failure, this handler stops and returns the failure
 * result. Already-written files from earlier names are left in place
 * because R31.7 only forbids writing on the failed call itself, and
 * cleaning up successful writes would be more confusing than helpful.
 */
export async function generateIconSet(
  args: GenerateIconSetArgs | undefined,
  ctx: McpToolContext,
): Promise<McpIconSetResult> {
  const a = args ?? {};

  if (typeof a.theme !== 'string' || a.theme.trim().length === 0) {
    return fail('INVALID_PROMPT', 'theme is required and must be a non-empty string');
  }
  if (!Array.isArray(a.names) || a.names.length === 0) {
    return fail('INVALID_PROMPT', 'names must be a non-empty string array');
  }
  const names: string[] = [];
  for (const n of a.names) {
    if (typeof n !== 'string' || n.trim().length === 0) {
      return fail('INVALID_PROMPT', 'every entry in names must be a non-empty string');
    }
    names.push(n);
  }
  const style = typeof a.style === 'string' ? a.style : undefined;
  const framework = coerceFramework(a.framework);
  const overwrite = a.overwrite === true;
  const workspaceArg =
    typeof a.workspace_root === 'string' ? a.workspace_root : undefined;
  const enhanceOptIn = coerceEnhancePromptFlag(a.enhance_prompt);

  const connErr = ensureConnected(ctx);
  if (connErr !== null) return connErr;

  const ws = tryResolveWorkspace(ctx, workspaceArg);
  if (ws.ok !== true) return ws;

  const savedPaths: string[] = [];
  let lastPrompt = '';
  let lastRequestId = '';
  let lastMimeType: ImageMimeType | null = null;

  for (const name of names) {
    const templated = PROMPT_TEMPLATES.iconSet(a.theme, name, style);
    const promptCheck = validateImagePrompt(templated);
    if (promptCheck.ok !== true) return promptCheck;

    // Re-check the connection before each request — a long-running set
    // could outlast a transient disconnect.
    const connErr2 = ensureConnected(ctx);
    if (connErr2 !== null) return connErr2;

    // Run the optional rewrite per-icon so each pictogram gets a
    // tailored brief. When opt-in is off, this is a no-op fast path.
    const enhanced = prepareImagePrompt({
      templated,
      kind: 'icon',
      perCallOptIn: enhanceOptIn,
    });
    const enhancedCheck = validateImagePrompt(enhanced.prompt);
    if (enhancedCheck.ok !== true) return enhancedCheck;
    const prompt = enhanced.prompt;
    lastPrompt = prompt;

    const request = buildImageRequest(prompt);
    lastRequestId = request.requestId;
    let finalChunk;
    try {
      finalChunk = await ctx.relayClient.submitAndAwait(request);
    } catch (err) {
      return mapRelayError(err);
    }

    const decoded = decodeFinalChunk(finalChunk);
    if (decoded.ok !== true) return decoded;
    lastMimeType = decoded.mimeType;

    // Use the icon name (slugified) for the filename stem so the set
    // produces predictable filenames like `icons/search.png`.
    const target = await resolveTargetPath({
      workspaceRoot: ws.workspaceRoot,
      framework,
      assetCategory: 'icon',
      prompt: name,
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
    savedPaths.push(target.absolutePath);
  }

  // We required names.length >= 1 above, so lastMimeType is non-null.
  if (lastMimeType === null) {
    return fail('INVALID_PROMPT', 'no icons generated');
  }

  return {
    ok: true,
    savedPaths,
    mimeType: lastMimeType,
    prompt: lastPrompt,
    requestId: lastRequestId,
    assetCategory: 'icon',
  };
}
