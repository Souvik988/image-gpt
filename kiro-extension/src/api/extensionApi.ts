/**
 * @file `api/extensionApi.ts` — public KIRO Extension API surface.
 *
 * Implements:
 *  - R29.1 — the object returned from `activate(ctx)` exposes a
 *            `generateImage(options): Promise<ImageResult>` function.
 *  - R29.2 — early-validates the option bag (prompt length, optional
 *            field shapes) before the relay round-trip.
 *  - R29.7 — every failure resolves with a structured `errorCode`
 *            payload; the facade never rejects, mirroring the
 *            non-throwing contract enforced by `AssetGenerator`.
 *
 * This module is the thin facade that forwards every well-formed call
 * to an injected {@link AssetGenerator}; the orchestration (relay
 * round-trip, framework detection, atomic write) lives there.
 *
 * The factory shape — `createExtensionApi({ assetGenerator })` —
 * matches the dependency-injection convention used elsewhere in the
 * extension so the unit test in task 22.15 can drive the API with a
 * fake generator and assert the error-branch surface.
 */

import type {
  AssetGenerator,
  GenerateOptions,
  ImageResult,
} from '../assets/assetGenerator.js';

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * Options accepted by {@link KiroGptBridgeApi.generateImage}. Mirrors
 * R29.1 / R29.2:
 *  - `prompt`        required, 1..4000 chars after trim.
 *  - `targetPath`    optional, workspace-relative or absolute.
 *  - `filename`      optional, must include a recognisable extension.
 *  - `framework`     optional override of the auto-detected framework.
 *  - `assetCategory` optional category from the shared closed set.
 *  - `overwrite`     optional boolean, default false.
 */
export type GenerateImageOptions = GenerateOptions;

/** Result returned by {@link KiroGptBridgeApi.generateImage}. R29.1 / R29.7. */
export type GenerateImageResult = ImageResult;

/**
 * Public extension API. Consumed by other extensions via:
 *
 * ```ts
 * const ext = vscode.extensions.getExtension('kiro-gpt-bridge.kiro-extension');
 * const api = await ext?.activate() as KiroGptBridgeApi | undefined;
 * await api?.generateImage({ prompt: '...' });
 * ```
 *
 * Implements R29.1.
 */
export interface KiroGptBridgeApi {
  /** Programmatic image-generation entry point. R29.1 / R29.2. */
  generateImage(opts: GenerateImageOptions): Promise<GenerateImageResult>;
}

/** Construction-time dependencies. */
export interface CreateExtensionApiDeps {
  /** Wired {@link AssetGenerator}. Owned by `extension.ts`. */
  assetGenerator: AssetGenerator;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Lower bound on the trimmed prompt length per R29.2. */
const PROMPT_MIN = 1;
/** Upper bound on the trimmed prompt length per R29.2. */
const PROMPT_MAX = 4000;

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Build the public extension API surface. Returned object is what
 * `activate(ctx)` returns to VS Code.
 *
 * The facade performs early input validation (R29.2) so a malformed
 * caller (`prompt` too short, missing, or too long) sees an
 * `INVALID_PROMPT` errorCode without consuming a relay round-trip.
 * Every other failure flows from {@link AssetGenerator.generate}.
 *
 * Implements R29.1, R29.2.
 *
 * @param deps See {@link CreateExtensionApiDeps}.
 * @returns    The {@link KiroGptBridgeApi} object.
 */
export function createExtensionApi(deps: CreateExtensionApiDeps): KiroGptBridgeApi {
  return {
    async generateImage(opts: GenerateImageOptions): Promise<GenerateImageResult> {
      // Surface a structured error for malformed option bags so the
      // caller sees a consistent shape (R29.7).
      if (opts === null || typeof opts !== 'object') {
        return {
          requestId: 'invalid',
          prompt: '',
          errorCode: 'INVALID_PROMPT',
          message: 'options must be an object',
        };
      }

      const promptRaw = typeof opts.prompt === 'string' ? opts.prompt : '';
      const trimmedLen = promptRaw.trim().length;
      if (trimmedLen < PROMPT_MIN || trimmedLen > PROMPT_MAX) {
        return {
          requestId: 'invalid',
          prompt: promptRaw,
          errorCode: 'INVALID_PROMPT',
          message: `prompt length must be ${PROMPT_MIN}..${PROMPT_MAX} chars (got ${trimmedLen})`,
        };
      }

      // Forward every option verbatim — `AssetGenerator.generate`
      // performs its own workspace / target / framework resolution.
      return deps.assetGenerator.generate(opts);
    },
  };
}
