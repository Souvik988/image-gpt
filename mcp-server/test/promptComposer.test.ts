/**
 * Unit tests for `promptComposer.ts` — the v2 prompt brain. Covers
 * per-kind blueprints, design-context injection, negative anchors,
 * and the 4000-char budget behavior.
 */

import { describe, it, expect } from 'vitest';

import {
  composePrompt,
  isPromptKind,
  PROMPT_KINDS,
  MAX_PROMPT_LEN,
  type PromptKind,
} from '../src/promptComposer.js';
import type { DesignContext } from '../src/designContext.js';

const DESIGN: DesignContext = {
  framework: 'next',
  brandName: 'acme',
  colors: ['#0f172a', '#38bdf8'],
  fonts: ['Inter'],
  radii: ['0.75rem'],
  packages: ['tailwindcss'],
  darkMode: true,
  brief: 'Match the project design system (brand "acme").',
};

describe('PROMPT_KINDS', () => {
  it('is a closed list containing the new asset kinds', () => {
    for (const kind of ['banner', 'og', 'icon3d', 'wireframe', 'favicon'] as const) {
      expect(PROMPT_KINDS).toContain(kind);
    }
    expect(isPromptKind('banner')).toBe(true);
    expect(isPromptKind('nope')).toBe(false);
    expect(isPromptKind(42)).toBe(false);
  });
});

describe('composePrompt', () => {
  it('emits a single line containing blueprint, specifics, and negatives', () => {
    const prompt = composePrompt({ kind: 'logo', specifics: 'Acme' });
    expect(prompt).not.toContain('\n');
    expect(prompt).toContain('Brand logo mark');
    expect(prompt).toContain('Acme');
    expect(prompt).toContain('No photorealism');
  });

  it('injects the design-system brief when provided', () => {
    const prompt = composePrompt({ kind: 'ui', specifics: 'settings page', design: DESIGN });
    expect(prompt).toContain('brand "acme"');
    expect(prompt).toContain('#0f172a');
  });

  it('appends caller style and avoid directives', () => {
    const prompt = composePrompt({
      kind: 'icon3d',
      specifics: 'rocket',
      style: 'glossy clay render',
      avoid: 'no purple',
    });
    expect(prompt).toContain('Style: glossy clay render');
    expect(prompt).toContain('no purple');
  });

  it('uses the 3D blueprint for icon3d and forbids flat looks', () => {
    const prompt = composePrompt({ kind: 'icon3d', specifics: 'cube' });
    expect(prompt).toContain('3D rendered icon');
    expect(prompt).toContain('No flat 2D look');
  });

  it('forbids embedded text on og images (text is overlaid in code)', () => {
    const prompt = composePrompt({ kind: 'og', specifics: 'launch card' });
    expect(prompt).toContain('No embedded text');
  });

  it('drops the design line before ever exceeding the wire budget', () => {
    const hugeSpecifics = 'x'.repeat(MAX_PROMPT_LEN - 10);
    const prompt = composePrompt({ kind: 'hero', specifics: hugeSpecifics, design: DESIGN });
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_LEN);
    // Negatives survive the trim.
    expect(prompt).toContain('No embedded headline text');
  });

  it('covers every kind without throwing', () => {
    for (const kind of PROMPT_KINDS as readonly PromptKind[]) {
      const prompt = composePrompt({ kind, specifics: 'subject', design: DESIGN });
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_LEN);
    }
  });
});
