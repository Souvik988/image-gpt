/**
 * Optional in-prompt expansion pre-stage for image-generation prompts.
 *
 * When enabled, the templated prompt is wrapped with a short directive
 * that asks ChatGPT to FIRST expand the brief into a comprehensive,
 * professional DALL-E prompt (concrete style anchors, exact hex colors,
 * composition, typography, negative anchors), THEN generate the image.
 * Both happen inside a single ChatGPT turn — no separate round-trip,
 * no chat-stream extraction, no second relay submission.
 *
 * Why this approach beats the previous two-call design
 * ---------------------------------------------------
 * The earlier implementation submitted a separate `chat` Request to
 * have ChatGPT rewrite the brief, awaited the typed reply, then
 * submitted a second `image` Request with the rewritten output. That
 * design had three issues:
 *
 *  1. The agent typed the rewrite question (often 4–5 KB) at 20–80 ms
 *     per keystroke, taking 2–4 minutes before ChatGPT could even
 *     start replying.
 *  2. The chat-stream extractor occasionally hit `chat_timeout` because
 *     ChatGPT's reply was long and slow.
 *  3. Two round-trips meant double the chance of any single failure
 *     killing the whole flow.
 *
 * The single-turn directive is exactly what a human user does when
 * pasting a brief into ChatGPT and saying "expand and generate" — it
 * exploits the fact that ChatGPT already runs internal prompt
 * rewriting before invoking DALL-E / GPT-Image-1. We give it explicit
 * guidance for that internal rewrite.
 *
 * Activation
 * ----------
 * The wrapper is applied when ANY of the following is true:
 *  1. The per-call argument `enhance_prompt: true` was passed.
 *  2. The environment variable `KIRO_GPT_MCP_PROMPT_REWRITE` resolves
 *     to one of `1`, `true`, `yes`, `on` (case-insensitive).
 *
 * Failure semantics
 * -----------------
 * Synchronous and infallible. The only "failure" is when the wrapped
 * prompt would exceed the 4000-char wire budget (R10.1) — in that
 * case the original templated prompt is returned unchanged and the
 * skip is logged. Image generation is never blocked by enhancement
 * logic.
 *
 * Implements:
 *   - R10.1 (final image prompt is 1–4000 chars).
 *   - R31.4 (centralised prompt construction; the wrapper is layered
 *     above the existing template build).
 *   - R31.7 (failures degrade to the original prompt; never crash
 *     the tool handler).
 *
 * @packageDocumentation
 */

// ─── Public surface ────────────────────────────────────────────────────────

/**
 * Closed enum of prompt kinds. Drives the directive wording so the
 * model uses the right vocabulary for the asset class.
 */
export type EnhancerKind =
  | 'logo'
  | 'hero'
  | 'icon'
  | 'ui'
  | 'mockup'
  | 'generic';

/**
 * Options accepted by {@link enhancePrompt}.
 */
export interface EnhancePromptOptions {
  /**
   * Per-call opt-in flag from the tool argument. When `true` the
   * wrapper is applied regardless of the env variable.
   */
  perCallOptIn?: boolean;
}

/**
 * Result of {@link enhancePrompt}. Always carries a usable `prompt`;
 * `enhanced` reports whether the wrapper was actually applied.
 */
export interface EnhancePromptResult {
  /**
   * Final prompt to forward to the image pipeline. Equal to the input
   * `templated` prompt when enhancement was disabled or the wrapper
   * would have exceeded the wire budget. Otherwise the wrapped string.
   */
  prompt: string;
  /** True iff the directive wrapper was applied. */
  enhanced: boolean;
  /**
   * When `enhanced === true`, the original templated prompt is
   * preserved here so callers can log both versions for diagnostics.
   * When `enhanced === false`, this field is omitted.
   */
  originalPrompt?: string;
}

// ─── Implementation ────────────────────────────────────────────────────────

/**
 * Maximum total prompt length permitted on the wire (R10.1, R10.7).
 */
const MAX_PROMPT_LEN = 4000;

/**
 * Per-kind one-line directive snippet appended to the universal
 * preamble. Each entry primes ChatGPT's internal prompt rewriter to
 * use the vocabulary that matches the asset class. Kept short
 * (~80 chars) so the wrapper overhead stays under ~280 chars total
 * and leaves room for verbose user input within the 4000-char cap.
 */
const KIND_DIRECTIVE: Readonly<Record<EnhancerKind, string>> = {
  logo: 'For a brand logo: name the mark geometry, ratio, padding, and exact hex colors',
  hero: 'For a marketing hero: name camera angle, focal length, lighting, palette hex, headline negative space, and aspect ratio',
  icon: 'For a UI pictogram: name stroke weight, corner radius, padding inside the 1:1 canvas, and 24px legibility',
  ui: 'For a production UI mockup: name layout grid, typography size weight family, color tokens with hex, spacing scale, and viewport',
  mockup: 'For a low-fi wireframe: name monochrome palette, blocky shapes, placeholder labels, and clear hierarchy',
  generic: 'Use concrete subject framing, named style references, exact hex colors, composition rules, and negative anchors',
};

/**
 * Universal preamble injected before the templated prompt when the
 * wrapper is active. ChatGPT routes prompts of this shape through
 * its internal expansion + DALL-E call in a single turn, so no
 * second round-trip is required.
 *
 * Total fixed overhead ≈ 220 chars; plus the per-kind directive
 * (~80 chars) brings the wrapper to ≈ 300 chars including
 * separators. Templated prompts up to ~3700 chars therefore fit
 * comfortably under {@link MAX_PROMPT_LEN}.
 */
const PREAMBLE =
  'First internally expand the brief below into a comprehensive ' +
  'professional DALL-E prompt with concrete style anchors, then ' +
  'generate that image. ';

/**
 * Resolve the env-variable opt-in. Returns `true` when the variable
 * resolves to one of the accepted truthy strings, case-insensitive.
 */
export function isEnvOptIn(envValue: string | undefined): boolean {
  if (typeof envValue !== 'string') return false;
  const lower = envValue.trim().toLowerCase();
  return lower === '1' || lower === 'true' || lower === 'yes' || lower === 'on';
}

/**
 * Wrap `templated` with the single-turn expansion directive when
 * enhancement is enabled, OR return the templated prompt unchanged
 * when enhancement is off / over budget. Synchronous and infallible.
 *
 * Implements R31.4 (rewrite layered above template build) and R31.7
 * (failures degrade to the original prompt).
 *
 * @param templated  The templated prompt produced by
 *                   {@link PROMPT_TEMPLATES}.
 * @param kind       Asset class — drives the per-kind directive.
 * @param logger     Optional structured stderr logger for diagnostics.
 *                   When omitted, skip logs are silently suppressed.
 * @param opts       Per-call overrides.
 */
export function enhancePrompt(
  templated: string,
  kind: EnhancerKind,
  logger?: (
    level: 'info' | 'error' | 'warn',
    event: string,
    fields?: Record<string, unknown>,
  ) => void,
  opts: EnhancePromptOptions = {},
): EnhancePromptResult {
  const envOptIn = isEnvOptIn(process.env.KIRO_GPT_MCP_PROMPT_REWRITE);
  const perCall = opts.perCallOptIn === true;
  const enabled = perCall || envOptIn;

  if (!enabled) {
    return { prompt: templated, enhanced: false };
  }

  const directive = KIND_DIRECTIVE[kind];
  const wrapped = `${PREAMBLE}${directive}. Brief: ${templated}`;

  if (wrapped.length > MAX_PROMPT_LEN) {
    if (logger !== undefined) {
      logger('warn', 'mcp_prompt_rewrite_skipped', {
        reason: 'templated_too_long_for_wrapper',
        templatedLength: templated.length,
        wrappedLength: wrapped.length,
        budget: MAX_PROMPT_LEN,
      });
    }
    return { prompt: templated, enhanced: false };
  }

  if (logger !== undefined) {
    logger('info', 'mcp_prompt_rewrite_applied', {
      kind,
      originalLength: templated.length,
      enhancedLength: wrapped.length,
    });
  }
  return {
    prompt: wrapped,
    enhanced: true,
    originalPrompt: templated,
  };
}
