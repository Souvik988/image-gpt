/**
 * Prompt Composer v2 — the "prompt brain" of the MCP server.
 *
 * Builds a comprehensive, production-grade image prompt from
 *  1. a per-kind blueprint (composition + style anchors), and
 *  2. the caller's specifics, and
 *  3. an optional {@link DesignContext} from `designContext.ts` so the
 *     asset inherits the project's actual palette / typography /
 *     radius language, and
 *  4. per-kind negative anchors that suppress the common failure modes
 *     (garbled text, watermarks, lorem-ipsum UI, flat 3D, …).
 *
 * This supersedes the flat `PROMPT_TEMPLATES` map for the new asset
 * kinds (banner, og image, 3D icon) and is the composition layer the
 * `analyze_design`-informed workflow builds on. The v1 templates remain
 * untouched for the existing five tools.
 *
 * Single-line discipline: every composed prompt is one line — the
 * browser-agent's fast-insert path handles newlines safely, but
 * single-line keeps parity with the v1 templates and the 4000-char
 * validation simple.
 *
 * @packageDocumentation
 */

import type { DesignContext } from './designContext.js';
import { describeDesignContext } from './designContext.js';

// ─── Public types ──────────────────────────────────────────────────────────

/** Closed enum of asset kinds the v2 composer understands. */
export const PROMPT_KINDS = [
  'logo',
  'hero',
  'banner',
  'icon',
  'icon3d',
  'ui',
  'wireframe',
  'og',
  'favicon',
  'illustration',
  'generic',
] as const;

/** Literal union derived from {@link PROMPT_KINDS}. */
export type PromptKind = typeof PROMPT_KINDS[number];

/** Narrow an arbitrary value to a {@link PromptKind}. */
export function isPromptKind(value: unknown): value is PromptKind {
  return typeof value === 'string' && (PROMPT_KINDS as readonly string[]).includes(value);
}

/** Inputs for {@link composePrompt}. */
export interface ComposePromptInput {
  /** Asset kind — selects the blueprint. */
  kind: PromptKind;
  /** Caller's description (brand name, scene, component, icon subject…). */
  specifics: string;
  /** Distilled design system injected when available. */
  design?: DesignContext | null;
  /** Caller's extra style directive, appended after the blueprint. */
  style?: string;
  /** Caller's extra negative anchors, appended to the kind's defaults. */
  avoid?: string;
}

// ─── Per-kind blueprints ───────────────────────────────────────────────────

interface KindBlueprint {
  /** Composition + style brief prepended to the specifics. */
  brief: string;
  /** Negative anchors appended to every prompt of this kind. */
  negative: string;
}

const BLUEPRINTS: Readonly<Record<PromptKind, KindBlueprint>> = {
  logo: {
    brief:
      'Brand logo mark. Flat vector, single subject centered on a transparent background, ' +
      'geometric and memorable, even stroke weights, balanced negative space, ' +
      'scalable from 16px favicon to billboard with no thin hairlines.',
    negative:
      'No photorealism, no background clutter, no drop shadows, no text artifacts, ' +
      'no garbled letters, no watermark, no signature.',
  },
  hero: {
    brief:
      'Marketing hero image. Strong focal subject with deliberate leading lines, ' +
      'generous negative space on one side for a headline overlay, intentional color story, ' +
      'cinematic lighting with soft ambient fill and rim highlights, rich tonal range.',
    negative:
      'No embedded headline text, no watermark, no signature, no busy composition ' +
      'behind the headline zone, no muddy mid-tones.',
  },
  banner: {
    brief:
      'Website banner graphic. Clean layout with a clear focal element offset to one side, ' +
      'flat or lightly-textured background, crisp edges, ad-safe margins on all sides, ' +
      'composition that survives downsizing to thumbnail width.',
    negative:
      'No lorem ipsum, no unreadable placeholder text, no watermarks, no cut-off elements ' +
      'at the frame edges, no cluttered micro-detail that vanishes at small sizes.',
  },
  icon: {
    brief:
      'UI pictogram icon. Flat outline style, 2px-equivalent stroke weight, rounded line caps, ' +
      'single foreground glyph centered on a square 1:1 canvas with generous padding, ' +
      'legible at 24px and consistent with a modern design-system icon set.',
    negative:
      'No gradients unless requested, no photorealism, no background fill, no text, ' +
      'no watermark, no thin strokes below 2px equivalent.',
  },
  icon3d: {
    brief:
      '3D rendered icon. Soft studio lighting, subtle ambient occlusion, rounded bevels, ' +
      'matte-to-satin material response, gentle depth of field, single object centered ' +
      'on a clean neutral backdrop, modern 3D illustration aesthetic in the style of ' +
      'contemporary product-icon renders.',
    negative:
      'No flat 2D look, no photo textures, no harsh shadows, no text, no watermark, ' +
      'no busy background, no clutter.',
  },
  ui: {
    brief:
      'High-fidelity UI mockup. Pixel-perfect layout on an 8-point grid, realistic typography ' +
      'hierarchy, accessible contrast, coherent component states, real-feeling placeholder ' +
      'content, Figma design-system screenshot aesthetic.',
    negative:
      'No lorem ipsum — use realistic copy, no cut-off or overlapping elements, ' +
      'no garbled glyphs, no browser-chrome artifacts, no watermark.',
  },
  wireframe: {
    brief:
      'Low-fidelity UI wireframe. Monochrome greyscale, blocky placeholder shapes, ' +
      'clear content hierarchy, annotation-friendly spacing, clean 1px structural lines.',
    negative:
      'No color fills, no photorealism, no realistic typography, no watermark, no clutter.',
  },
  og: {
    brief:
      'Open Graph social card. Bold central focal element, high contrast at thumbnail size, ' +
      'headline-safe negative space on the left third, flat modern gradient or solid ' +
      'background, brand-consistent color story.',
    negative:
      'No embedded text or headline (text is overlaid in code), no watermarks, ' +
      'no busy micro-detail that dies at 400px wide, no clutter.',
  },
  favicon: {
    brief:
      'Favicon glyph. Ultra-simple single mark centered on a square canvas, ' +
      'bold shapes readable at 16px, high internal contrast, no fine detail.',
    negative:
      'No text, no gradients with fine transitions, no watermark, no thin strokes, ' +
      'no detail that disappears at 16px.',
  },
  illustration: {
    brief:
      'Editorial illustration. Cohesive flat or lightly-textured style, clear focal narrative, ' +
      'harmonized palette, deliberate composition with breathing room.',
    negative:
      'No text artifacts, no watermark, no signature, no muddy palette, no clutter.',
  },
  generic: {
    brief:
      'Production-grade image. Concrete subject framing, named style references, ' +
      'deliberate composition, coherent lighting.',
    negative:
      'No text artifacts, no garbled letters, no watermark, no signature, no clutter.',
  },
};

// ─── Composer ──────────────────────────────────────────────────────────────

/** Maximum total prompt length accepted by the wire (R10.1). */
export const MAX_PROMPT_LEN = 4000;

/**
 * Compose a comprehensive prompt for one asset.
 *
 * Order: blueprint brief → caller specifics → design-system line →
 * caller style → negative anchors. When the composition would exceed
 * {@link MAX_PROMPT_LEN} the design line and caller extras are dropped
 * first (blueprint + specifics are load-bearing and never truncated).
 */
export function composePrompt(input: ComposePromptInput): string {
  const blueprint = BLUEPRINTS[input.kind];
  const specifics = input.specifics.trim();

  const segments: string[] = [blueprint.brief];
  if (specifics.length > 0) segments.push(specifics);

  const designLine =
    input.design !== undefined && input.design !== null
      ? describeDesignContext(input.design)
      : '';
  if (designLine.length > 0) segments.push(designLine);

  if (typeof input.style === 'string' && input.style.trim().length > 0) {
    segments.push(`Style: ${input.style.trim()}`);
  }

  let prompt = segments.join(' ');

  const negatives: string[] = [blueprint.negative];
  if (typeof input.avoid === 'string' && input.avoid.trim().length > 0) {
    negatives.push(input.avoid.trim());
  }
  const negativeClause = negatives.join(' ');

  // Budget: negatives must fit. Drop the design line first, then trim
  // extras — the blueprint + specifics are never dropped.
  if (prompt.length + negativeClause.length + 1 > MAX_PROMPT_LEN) {
    // Recompute without the design line.
    const withoutDesign = [blueprint.brief, specifics];
    if (typeof input.style === 'string' && input.style.trim().length > 0) {
      withoutDesign.push(`Style: ${input.style.trim()}`);
    }
    prompt = withoutDesign.join(' ');
  }
  if (prompt.length + negativeClause.length + 1 > MAX_PROMPT_LEN) {
    // Last resort: hard-trim the specifics so the negatives survive.
    const budget = MAX_PROMPT_LEN - negativeClause.length - 1 - blueprint.brief.length - 1;
    const trimmedSpecifics =
      budget > 0 ? specifics.slice(0, Math.max(0, budget)) : '';
    prompt = [blueprint.brief, trimmedSpecifics].filter((s) => s.length > 0).join(' ');
  }

  return `${prompt} ${negativeClause}`;
}
