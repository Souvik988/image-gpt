/**
 * Shared types and helpers for the MCP tool handlers.
 *
 * Implements R31.6 (success result shape) and R31.7 (failure result
 * shape with closed error codes). Centralised here so the five tool
 * handlers (`generateImage`, `generateLogo`, `generateHero`,
 * `generateIconSet`, `generateUiMockup`) stay tiny and consistent.
 */

import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';

import {
  base64Decode,
  type AssetCategory,
  type ErrorCode,
  type Request,
  type StreamChunk,
} from '@kiro-gpt-bridge/shared';

import type { McpRelayClient } from '../relayClient.js';
import type { WorkspaceResolver } from '../workspaceResolver.js';
import { WorkspaceRequiredError } from '../workspaceResolver.js';
import {
  resolvePath,
  slugify,
  extensionForMime,
  type Framework,
  type ImageMimeType,
} from '../pathResolver.js';
import {
  enhancePrompt,
  type EnhancerKind,
  type EnhancePromptResult,
} from '../promptEnhancer.js';

// ─── Public result type ────────────────────────────────────────────────────

/**
 * Shape returned by the four single-asset tools (`generate_image`,
 * `generate_logo`, `generate_hero`, `generate_ui_mockup`). Implements
 * R31.6.
 */
export interface McpImageSuccess {
  ok: true;
  /** Absolute path of the saved image file. */
  savedPath: string;
  /** MIME type of the saved image. */
  mimeType: ImageMimeType;
  /** Final prompt that was sent to the relay (after template build). */
  prompt: string;
  /** Wire `requestId` of the underlying image Request. */
  requestId: string;
  /** Asset category that drove the path resolution. */
  assetCategory: AssetCategory;
}

/**
 * Shape returned by `generate_icon_set`. Implements R31.6.
 */
export interface McpIconSetSuccess {
  ok: true;
  /** Absolute paths of every saved icon file, in input order. */
  savedPaths: string[];
  /** MIME type of the saved icons (assumed uniform across the set). */
  mimeType: ImageMimeType;
  /** Last prompt sent to the relay (icons share a theme). */
  prompt: string;
  /** Wire `requestId` of the most recent image Request. */
  requestId: string;
  /** Always `'icon'` for this tool. */
  assetCategory: 'icon';
}

/**
 * Shape returned on failure. Implements R31.7 (closed error codes).
 */
export interface McpFailure {
  ok: false;
  errorCode: ErrorCode;
  message: string;
}

/** Single-asset success or failure. */
export type McpImageResult = McpImageSuccess | McpFailure;
/** Icon-set success or failure. */
export type McpIconSetResult = McpIconSetSuccess | McpFailure;

// ─── Tool handler context ──────────────────────────────────────────────────

/**
 * Dependencies injected into every tool handler. Centralised so each
 * handler stays a thin function that builds a prompt and delegates the
 * remaining mechanics here.
 */
export interface McpToolContext {
  /** Live relay client. */
  relayClient: McpRelayClient;
  /** Workspace resolver (env or per-call arg). */
  workspaceResolver: WorkspaceResolver;
}

// ─── Image MIME type guard ─────────────────────────────────────────────────

/**
 * Closed list of MIME types the MCP server is willing to write. Mirrors
 * the wire schema's `StreamChunk.mediaType` literal union.
 */
const SUPPORTED_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

/** Type guard for {@link ImageMimeType}. */
export function isSupportedMime(value: string | undefined): value is ImageMimeType {
  return typeof value === 'string' && SUPPORTED_MIME_TYPES.has(value);
}

// ─── Framework + asset-category guards ─────────────────────────────────────

const FRAMEWORK_VALUES: ReadonlySet<string> = new Set([
  'next',
  'nuxt',
  'sveltekit',
  'vite',
  'angular',
  'cra',
  'unknown',
]);

/** Coerce an arbitrary value to a {@link Framework}. Defaults to `unknown`. */
export function coerceFramework(value: unknown): Framework {
  if (typeof value === 'string' && FRAMEWORK_VALUES.has(value)) {
    return value as Framework;
  }
  return 'unknown';
}

const ASSET_CATEGORY_VALUES: ReadonlySet<string> = new Set([
  'logo',
  'hero',
  'icon',
  'illustration',
  'background',
  'mockup',
  'other',
]);

/** Coerce an arbitrary value to an {@link AssetCategory}. */
export function coerceAssetCategory(
  value: unknown,
  fallback: AssetCategory,
): AssetCategory {
  if (typeof value === 'string' && ASSET_CATEGORY_VALUES.has(value)) {
    return value as AssetCategory;
  }
  return fallback;
}

// ─── Failure helpers ───────────────────────────────────────────────────────

/** Build a structured failure with the given error code and message. */
export function fail(errorCode: ErrorCode, message: string): McpFailure {
  return { ok: false, errorCode, message };
}

/**
 * Map a relay-side error encountered during {@link McpRelayClient.submitAndAwait}
 * to the corresponding closed-enum {@link ErrorCode}.
 *
 * Implements R31.7.
 */
export function mapRelayError(err: unknown): McpFailure {
  const message = err instanceof Error ? err.message : String(err);
  switch (message) {
    case 'mcp_relay_disconnected':
      return fail('RELAY_UNREACHABLE', 'relay disconnected mid-flight');
    case 'mcp_relay_timeout':
      return fail('IMAGE_TIMEOUT', 'no final chunk received before deadline');
    default:
      return fail('CHATGPT_UNAVAILABLE', message);
  }
}

// ─── Path-resolution input ────────────────────────────────────────────────

/** Inputs for {@link resolveTargetPath}. */
export interface ResolveTargetPathInput {
  workspaceRoot: string;
  framework: Framework;
  assetCategory: AssetCategory;
  /**
   * User-supplied filename (with or without extension). When omitted,
   * the stem is derived from the prompt via {@link slugify} and the
   * extension is appended from {@link extensionForMime}.
   */
  filename?: string;
  /** Prompt, used to derive the filename stem when `filename` is absent. */
  prompt: string;
  /** MIME type of the saved image (drives the extension). */
  mimeType: ImageMimeType;
  /** Whether to overwrite an existing file. Default false (R30.4). */
  overwrite?: boolean;
}

/**
 * Compute the absolute target path for a generated asset, ensuring the
 * filename has the correct extension and (when `overwrite` is false)
 * appending `-2`, `-3`, ..., `-99` until a free path is found. Returns a
 * {@link McpFailure} with `TARGET_EXISTS` when 99 suffixes are taken.
 *
 * Implements R30.3, R30.4.
 */
export async function resolveTargetPath(
  input: ResolveTargetPathInput,
): Promise<{ ok: true; absolutePath: string } | McpFailure> {
  const ext = extensionForMime(input.mimeType);

  // Build the initial filename (stem + extension).
  let stem: string;
  if (typeof input.filename === 'string' && input.filename.trim().length > 0) {
    const parsed = path.parse(input.filename);
    stem = parsed.name.length > 0 ? parsed.name : slugify(input.prompt);
  } else {
    stem = slugify(input.prompt);
  }

  const baseFilename = `${stem}${ext}`;
  const baseAbs = resolvePath({
    workspaceRoot: input.workspaceRoot,
    framework: input.framework,
    assetCategory: input.assetCategory,
    filename: baseFilename,
  });

  if (input.overwrite === true) {
    return { ok: true, absolutePath: baseAbs };
  }

  // Try the bare path first, then -2..-99 suffixes if it already exists.
  if (!(await pathExists(baseAbs))) {
    return { ok: true, absolutePath: baseAbs };
  }
  for (let n = 2; n <= 99; n += 1) {
    const candidate = resolvePath({
      workspaceRoot: input.workspaceRoot,
      framework: input.framework,
      assetCategory: input.assetCategory,
      filename: `${stem}-${n}${ext}`,
    });
    if (!(await pathExists(candidate))) {
      return { ok: true, absolutePath: candidate };
    }
  }
  return fail(
    'TARGET_EXISTS',
    `every suffix -2..-99 is taken for ${baseFilename}`,
  );
}

// ─── Filesystem helpers ────────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically write `bytes` to `targetPath` by writing to a `.tmp-XXXX`
 * sibling and renaming. Creates intermediate folders as needed (R30.5).
 * On any error, best-effort `unlink(tmp)` so a partial file does not
 * survive (R19.6).
 */
export async function atomicWrite(
  targetPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const tmpPath = `${targetPath}.tmp-${randomBytes(6).toString('hex')}`;
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await fsp.writeFile(tmpPath, bytes);
    await fsp.rename(tmpPath, targetPath);
  } catch (err) {
    try {
      await fsp.unlink(tmpPath);
    } catch {
      // Best-effort cleanup, ignore secondary failures.
    }
    throw err;
  }
}

// ─── Request builder ───────────────────────────────────────────────────────

/**
 * Build the wire-shaped {@link Request} for an image generation. The
 * `clientId` is the literal string `'mcp'` so logs can attribute the
 * call to this server, and `sessionId` is also `'mcp'` because the MCP
 * server is session-less.
 *
 * The `origin` field is set to the closed-enum value `'mcp'` per
 * R30.8 / R31.6 / R32.3 so the Relay_Server logger emits
 * `origin: "mcp"` on every lifecycle entry for this Request — letting
 * operators distinguish MCP-tool-driven traffic from panel and API
 * generation paths in a single log stream.
 */
export function buildImageRequest(prompt: string): Request {
  return {
    protocolVersion: 1,
    requestId: randomUUID(),
    clientId: 'mcp',
    sessionId: 'mcp',
    type: 'image',
    prompt,
    submittedAt: Date.now(),
    origin: 'mcp',
  };
}

// ─── Final-chunk decoder ───────────────────────────────────────────────────

/**
 * Validate a final {@link StreamChunk} and decode its base64 payload into
 * raw bytes. Returns a {@link McpFailure} when the chunk carries an error
 * code, an unsupported MIME type, or no base64 payload.
 */
export function decodeFinalChunk(
  chunk: StreamChunk,
): { ok: true; bytes: Uint8Array; mimeType: ImageMimeType } | McpFailure {
  if (chunk.errorCode !== undefined) {
    return fail(chunk.errorCode, chunk.message ?? chunk.errorCode);
  }
  if (chunk.status !== undefined && chunk.status !== 'completed') {
    return fail(
      'CHATGPT_UNAVAILABLE',
      `terminal status ${chunk.status} without errorCode`,
    );
  }
  if (!isSupportedMime(chunk.mediaType)) {
    return fail(
      'CHATGPT_UNAVAILABLE',
      `unsupported or missing mediaType: ${String(chunk.mediaType)}`,
    );
  }
  if (typeof chunk.base64 !== 'string' || chunk.base64.length === 0) {
    return fail('CHATGPT_UNAVAILABLE', 'final chunk missing base64 payload');
  }
  try {
    const bytes = base64Decode(chunk.base64);
    return { ok: true, bytes, mimeType: chunk.mediaType };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return fail('CHATGPT_UNAVAILABLE', `base64 decode failed: ${message}`);
  }
}

// ─── Workspace resolution helper ───────────────────────────────────────────

/**
 * Resolve the workspace root for the current tool call, translating a
 * {@link WorkspaceRequiredError} into a structured {@link McpFailure}
 * with the `WORKSPACE_REQUIRED` error code.
 */
export function tryResolveWorkspace(
  ctx: McpToolContext,
  perCallArg?: string,
): { ok: true; workspaceRoot: string } | McpFailure {
  try {
    const root = ctx.workspaceResolver.resolve(perCallArg);
    return { ok: true, workspaceRoot: root };
  } catch (err) {
    if (err instanceof WorkspaceRequiredError) {
      return fail('WORKSPACE_REQUIRED', err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    return fail('WORKSPACE_REQUIRED', message);
  }
}

// ─── Prompt validation ─────────────────────────────────────────────────────

/**
 * Validate an image prompt per R10.7 (1–4000 chars, not all whitespace).
 * Returns a {@link McpFailure} with `INVALID_PROMPT` on any violation.
 */
export function validateImagePrompt(
  prompt: string,
): { ok: true } | McpFailure {
  if (prompt.trim().length === 0) {
    return fail('INVALID_PROMPT', 'prompt is empty or whitespace-only');
  }
  if (prompt.length > 4000) {
    return fail('INVALID_PROMPT', 'prompt exceeds 4000 characters');
  }
  return { ok: true };
}

// ─── Connection guard ──────────────────────────────────────────────────────

/**
 * Short-circuit when the relay is not currently connected. Implements
 * R31.7 — every tool returns `RELAY_UNREACHABLE` without writing
 * anything.
 */
export function ensureConnected(ctx: McpToolContext): McpFailure | null {
  if (!ctx.relayClient.isConnected()) {
    return fail('RELAY_UNREACHABLE', 'relay client is not connected');
  }
  return null;
}

// ─── Stderr logger (shared with index.ts logging contract) ─────────────────

/**
 * Structured stderr logger used by the optional prompt-enhancer
 * pre-stage. Mirrors the JSON shape emitted by `index.ts` so log
 * consumers can fold both streams together.
 *
 * Stdout is reserved for MCP protocol traffic; every diagnostic line
 * MUST go to stderr (R30.8).
 */
export function logToolEvent(
  level: 'info' | 'error' | 'warn',
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    origin: 'mcp',
    ...fields,
  });
  // eslint-disable-next-line no-console -- MCP stderr logging contract (R30.8)
  console.error(line);
}

// ─── Optional prompt-rewrite pre-stage ─────────────────────────────────────

/**
 * Inputs for {@link prepareImagePrompt}.
 */
export interface PrepareImagePromptInput {
  /** Templated prompt produced by `PROMPT_TEMPLATES.<kind>(...)`. */
  templated: string;
  /** Asset class — drives the per-kind directive in the wrapper. */
  kind: EnhancerKind;
  /**
   * Per-call opt-in flag from the tool argument (`enhance_prompt`).
   * When `true`, applies the wrapper regardless of the env variable.
   * When `false` or `undefined`, falls back to the env variable.
   */
  perCallOptIn?: boolean;
}

/**
 * Apply the optional single-turn expansion wrapper. Synchronous —
 * no chat round-trip, no relay dependency. The wrapper instructs
 * ChatGPT to expand the templated brief into a richer DALL-E prompt
 * inside the same turn it generates the image.
 *
 * Implements R31.4 (rewrite layered above template build) and R31.7
 * (failures fall back to the original prompt; never crash the tool).
 */
export function prepareImagePrompt(
  input: PrepareImagePromptInput,
): EnhancePromptResult {
  return enhancePrompt(input.templated, input.kind, logToolEvent, {
    perCallOptIn: input.perCallOptIn === true,
  });
}

/**
 * Coerce an arbitrary value into the per-call `enhance_prompt`
 * boolean. Centralised here so each tool handler reads the same
 * accepted shapes (literal `true`/`false`).
 */
export function coerceEnhancePromptFlag(value: unknown): boolean {
  return value === true;
}
