/**
 * Versioned prompt templates for the MCP server's image-generation tools.
 *
 * Implements R31.3 (the five MCP tools) and R31.4 (each tool builds its
 * prompt by combining a tool-specific template with user-supplied
 * parameters before forwarding the request to the relay).
 *
 * Centralising the templates here keeps prompt phrasing consistent
 * across tools and prevents drift when the wording is tuned. Each
 * template returns a single chat-line string that, when combined with
 * the upstream `validateImagePrompt` length check, stays comfortably
 * within the 1–4000 character image-prompt budget (R10.1, R10.7).
 *
 * Prompt-engineering principles applied to every template:
 *
 *  1. **Subject specificity** — every template names the subject and
 *     the canonical composition (centred, full-bleed, etc.) so
 *     DALL-E / GPT-Image-1 does not have to guess.
 *  2. **Style anchors** — concrete stylistic references (Material 3,
 *     iOS 17 HIG, Bauhaus, Swiss design) instead of vague adjectives
 *     like "modern" which models interpret inconsistently.
 *  3. **Technical attributes** — explicit aspect ratio, resolution
 *     hint, colour space, and rendering engine cue (e.g., "Figma
 *     screenshot", "vector SVG export").
 *  4. **Lighting / mood** — for photographic outputs, named lighting
 *     setups (golden-hour, three-point softbox, overcast) which the
 *     model maps to coherent illumination.
 *  5. **Negative anchors** — explicit "no text artifacts, no garbled
 *     text, no watermark, no signature" suffixes which measurably
 *     reduce common DALL-E failure modes (text in logos, embedded
 *     watermark text in heroes).
 *  6. **One-line discipline** — every template emits a single line
 *     even when long, because ChatGPT's chat composer collapses
 *     newlines and newline-injected prompts can desynchronise the
 *     keystroke-jitter typing path (R9.2).
 *
 * Style note: every template ends with a period and avoids
 * exclamation marks per the project response-style guide.
 *
 * @packageDocumentation
 */

/** Public surface of the template module. */
export interface PromptTemplates {
  /**
   * Build the prompt for `generate_logo`. Implements R31.3 (logo) and
   * R31.4 (template + user params combined).
   *
   * @param brand     The brand name to render in the logo (1–4000 chars
   *                  upstream-validated). Required.
   * @param style     Optional stylistic descriptor; defaults to a
   *                  modern, flexible vector style suitable for both
   *                  light and dark application backgrounds.
   * @param palette   Optional colour-palette descriptor; defaults to a
   *                  contemporary muted palette. Specify hex codes
   *                  (e.g., "#0F172A and #38BDF8") for exact control.
   */
  logo(brand: string, style?: string, palette?: string): string;

  /**
   * Build the prompt for `generate_hero`. Implements R31.3 (hero) and
   * R31.4.
   *
   * @param scene         Scene description for the hero image.
   * @param aspectRatio   Optional aspect-ratio descriptor; defaults to
   *                      "16:9 ultrawide" which renders well across
   *                      desktop and tablet hero placements.
   */
  hero(scene: string, aspectRatio?: string): string;

  /**
   * Build the prompt for one icon inside `generate_icon_set`.
   * Implements R31.3 (icon set) and R31.4. The caller invokes this
   * template once per name in `names: string[]` so the icons stay
   * visually coherent.
   *
   * @param theme  Shared theme that ties the icon set together.
   * @param name   The specific icon name (e.g., "search", "settings").
   * @param style  Optional stylistic descriptor; defaults to a flat
   *               outline style suitable for UI use.
   */
  iconSet(theme: string, name: string, style?: string): string;

  /**
   * Build the prompt for `generate_ui_mockup`. Implements R31.3 (UI
   * mockup) and R31.4.
   *
   * @param component  Component description (e.g., "settings page",
   *                   "checkout form").
   * @param viewport   Optional viewport descriptor; defaults to a
   *                   high-fidelity desktop frame.
   */
  uiMockup(component: string, viewport?: string): string;

  /**
   * Build the prompt for `generate_image`. The generic tool wraps the
   * caller's prompt with universal quality anchors and negative
   * anchors but preserves their description verbatim. Implements
   * R31.3 (generic image) and R31.4.
   */
  generic(prompt: string): string;
}

// ─── Reusable building blocks ───────────────────────────────────────────────

/**
 * Universal quality anchors applied to every template. Adds a
 * production-grade rendering cue and asks the model to suppress the
 * common artefacts (garbled text, watermarks, grain) that DALL-E /
 * GPT-Image-1 emit by default on unconstrained prompts.
 *
 * Kept short (~140 chars) so it leaves headroom for verbose user
 * input within the 4000-char budget.
 */
const QUALITY_ANCHORS =
  'High fidelity, sharp focus, balanced composition, ' +
  'no text artifacts, no garbled letters, no watermark, no signature.';

/**
 * Anchors specific to brand / vector outputs. Pushes the model
 * toward a clean SVG aesthetic and away from photo-realistic noise.
 */
const VECTOR_ANCHORS =
  'Clean vector lines, even stroke weights, transparent background, ' +
  'single subject centered, no background clutter.';

/**
 * Anchors specific to UI / interface outputs. Asks for grid-aligned
 * layout, real typography, and an interactive look that mirrors a
 * Figma design-system screenshot.
 */
const UI_ANCHORS =
  'Pixel-perfect layout, 8-point grid alignment, realistic UI typography, ' +
  'high-contrast accessible color, Figma export aesthetic, ' +
  'rendered as a polished design-system screenshot.';

/**
 * Anchors specific to photographic outputs. Names a coherent
 * lighting setup and modern camera optics so the model stops
 * defaulting to muddy mid-tones.
 */
const PHOTO_ANCHORS =
  'Cinematic lighting, soft natural ambient with rim highlights, ' +
  '35mm full-frame camera aesthetic, shallow depth of field, ' +
  'rich tonal range.';

// ─── Template instance ─────────────────────────────────────────────────────

/**
 * The shared template instance used by every tool handler. Exported
 * as a const so tests can import it directly without a factory call.
 *
 * Each template returns a single line (no `\n`) so the
 * keystroke-jitter typing path in `chatDriver.ts` does not have to
 * handle the Enter-key edge case (which submits the prompt early).
 */
export const PROMPT_TEMPLATES: PromptTemplates = {
  logo(
    brand: string,
    style: string = 'modern minimalist vector mark',
    palette: string = 'contemporary muted with one accent color',
  ): string {
    return (
      `Brand logo for "${brand}". ` +
      `Style: ${style}. Color palette: ${palette}. ` +
      'Geometric, memorable, scalable from 16px favicon to billboard. ' +
      `${VECTOR_ANCHORS} ${QUALITY_ANCHORS}`
    );
  },

  hero(scene: string, aspectRatio: string = '16:9 ultrawide'): string {
    return (
      `Marketing hero banner. Scene: ${scene}. ` +
      `Aspect ratio: ${aspectRatio}. ` +
      'Strong negative space on one side for headline overlay, ' +
      'leading lines toward the subject, deliberate color story. ' +
      `${PHOTO_ANCHORS} ${QUALITY_ANCHORS}`
    );
  },

  iconSet(
    theme: string,
    name: string,
    style: string = 'flat outline, 2px stroke weight, rounded line caps',
  ): string {
    return (
      `Pictogram icon for "${name}" within the "${theme}" set. ` +
      `Style: ${style}. ` +
      'Square 1:1 canvas, single foreground glyph, generous padding, ' +
      'designed to read clearly at 24px UI size. ' +
      `${VECTOR_ANCHORS} ${QUALITY_ANCHORS}`
    );
  },

  uiMockup(
    component: string,
    viewport: string = 'desktop 1440x900',
  ): string {
    return (
      `UI design mockup of "${component}". ` +
      `Viewport: ${viewport}. ` +
      'Follow current iOS 17 / Material 3 / Tailwind design-system ' +
      'conventions where appropriate. Show realistic placeholder ' +
      'content, real-feeling navigation, and a coherent component ' +
      'hierarchy. ' +
      `${UI_ANCHORS} ${QUALITY_ANCHORS}`
    );
  },

  generic(prompt: string): string {
    const trimmed = prompt.trim();
    return `${trimmed}. ${QUALITY_ANCHORS}`;
  },
};

// ───────────────────────── buildPrompt — unified entry ────────────────────

/**
 * Closed enum of prompt kinds accepted by {@link buildPrompt}.
 *
 * `ui` and `mockup` are intentionally separate: `ui` is for a polished,
 * production-style UI mockup, while `mockup` is the lower-fidelity
 * wireframe variant used during early planning.
 */
export type PromptKind = 'logo' | 'hero' | 'icon' | 'ui' | 'mockup';

/**
 * Per-kind style guidance prepended to the user-supplied specifics.
 * Kept as an exported const so tests and the steering doc can pin
 * the exact phrasing without having to call the function. Each
 * prefix bundles a coherent style brief, the relevant building-block
 * anchors, and the universal quality anchors so the result reads as
 * a single coherent prompt rather than a stitched sentence list.
 */
export const PROMPT_STYLE_PREFIX: Readonly<Record<PromptKind, string>> = {
  logo:
    `Modern minimalist vector logo mark, geometric and memorable, ` +
    `scalable from favicon to billboard. ` +
    `${VECTOR_ANCHORS} ${QUALITY_ANCHORS}`,
  hero:
    `Cinematic 16:9 hero banner with strong negative space for ` +
    `headline overlay, intentional color story. ` +
    `${PHOTO_ANCHORS} ${QUALITY_ANCHORS}`,
  icon:
    `Flat outline pictogram icon, 2px stroke weight, rounded caps, ` +
    `square 1:1 canvas, optimised for 24px UI size. ` +
    `${VECTOR_ANCHORS} ${QUALITY_ANCHORS}`,
  ui:
    `Polished production UI mockup following current iOS 17 / ` +
    `Material 3 / Tailwind design-system conventions. ` +
    `${UI_ANCHORS} ${QUALITY_ANCHORS}`,
  mockup:
    `Low-fidelity wireframe UI mockup, monochrome with grey-scale ` +
    `placeholders, blocky shapes, annotation-friendly. ` +
    `${UI_ANCHORS} ${QUALITY_ANCHORS}`,
};

/**
 * Build a high-quality DALL-E / GPT-Image-1 prompt by prefixing
 * kind-specific style guidance to a free-form `specifics` string.
 *
 * Cites R31.2: when the MCP server connects to the Relay_Server as a
 * KIRO_Client, every tool call ultimately submits an image Request
 * whose `prompt` field is produced here. Centralising the per-kind
 * style guidance prevents drift between tools (R31.3 / R31.4) so the
 * Relay_Server and Browser_Agent always see consistent phrasing.
 *
 * Usage:
 * ```ts
 * buildPrompt('logo', 'Acme, deep navy and gold')
 *   // → '<logo prefix>. Acme, deep navy and gold'
 * ```
 *
 * @param kind       One of `'logo' | 'hero' | 'icon' | 'ui' | 'mockup'`.
 * @param specifics  Free-form descriptor (brand, scene, icon name,
 *                   component, etc.). When empty or whitespace-only,
 *                   the returned prompt is the bare prefix so callers
 *                   can still build something the relay will accept;
 *                   the per-tool handlers run `validateImagePrompt`
 *                   against the result and surface `INVALID_PROMPT`
 *                   when the final length is out of range (R10.7).
 * @returns          A single-line string suitable for use as
 *                   `Request.prompt`. Length is bounded by the input;
 *                   callers MUST validate against the 1–4000 char
 *                   image-prompt limit before submitting.
 */
export function buildPrompt(kind: PromptKind, specifics: string): string {
  const prefix = PROMPT_STYLE_PREFIX[kind];
  const trimmed = typeof specifics === 'string' ? specifics.trim() : '';
  if (trimmed.length === 0) {
    return prefix;
  }
  return `${prefix} ${trimmed}`;
}
