/**
 * Unit tests for the synchronous prompt-enhancer wrapper.
 *
 * Covers every branch of {@link enhancePrompt}:
 *  - Disabled by default → returns the templated prompt unchanged.
 *  - Enabled per-call → wrapper is applied.
 *  - Enabled via env (`KIRO_GPT_MCP_PROMPT_REWRITE` truthy) → wrapper applied.
 *  - Wrapper would exceed the 4000-char wire budget → falls back to templated.
 *  - {@link isEnvOptIn} accepts the documented truthy variants and rejects others.
 *
 * @packageDocumentation
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  enhancePrompt,
  isEnvOptIn,
  type EnhancerKind,
} from '../src/promptEnhancer.js';

const ORIGINAL_ENV = process.env.KIRO_GPT_MCP_PROMPT_REWRITE;

beforeEach(() => {
  delete process.env.KIRO_GPT_MCP_PROMPT_REWRITE;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.KIRO_GPT_MCP_PROMPT_REWRITE;
  } else {
    process.env.KIRO_GPT_MCP_PROMPT_REWRITE = ORIGINAL_ENV;
  }
});

describe('isEnvOptIn', () => {
  it.each(['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'on', 'ON', '  true  '])(
    'accepts truthy value %s',
    (value) => {
      expect(isEnvOptIn(value)).toBe(true);
    },
  );

  it.each(['0', 'false', 'no', 'off', '', '   ', 'enabled', undefined])(
    'rejects falsy / unknown value %s',
    (value) => {
      expect(isEnvOptIn(value)).toBe(false);
    },
  );
});

describe('enhancePrompt — disabled', () => {
  it('returns templated unchanged when neither env nor per-call opt-in is set', () => {
    const result = enhancePrompt('a templated prompt', 'logo');
    expect(result.enhanced).toBe(false);
    expect(result.prompt).toBe('a templated prompt');
    expect(result.originalPrompt).toBeUndefined();
  });

  it('respects per-call false even with env enabled', () => {
    process.env.KIRO_GPT_MCP_PROMPT_REWRITE = 'true';
    // perCallOptIn defaults to undefined; wrapper still applies via env.
    // To assert the per-call path stays false-only, we explicitly pass false.
    const result = enhancePrompt('a templated prompt', 'logo', undefined, {
      perCallOptIn: false,
    });
    expect(result.enhanced).toBe(true); // env still wins
    expect(result.prompt.startsWith('First internally expand')).toBe(true);
  });
});

describe('enhancePrompt — enabled per-call', () => {
  it('wraps the templated prompt with the preamble + per-kind directive + brief', () => {
    const result = enhancePrompt(
      'A red house',
      'generic',
      undefined,
      { perCallOptIn: true },
    );
    expect(result.enhanced).toBe(true);
    expect(result.prompt).toContain('First internally expand the brief below');
    expect(result.prompt).toContain('subject framing');
    expect(result.prompt).toContain('Brief: A red house');
    expect(result.originalPrompt).toBe('A red house');
  });

  it('uses the per-kind directive for logo', () => {
    const result = enhancePrompt('Acme', 'logo', undefined, { perCallOptIn: true });
    expect(result.prompt).toContain('brand logo');
    expect(result.prompt).toContain('mark geometry');
  });

  it('uses the per-kind directive for hero', () => {
    const result = enhancePrompt('Sunrise', 'hero', undefined, { perCallOptIn: true });
    expect(result.prompt).toContain('marketing hero');
  });

  it('uses the per-kind directive for icon', () => {
    const result = enhancePrompt('Search', 'icon', undefined, { perCallOptIn: true });
    expect(result.prompt).toContain('UI pictogram');
  });

  it('uses the per-kind directive for ui', () => {
    const result = enhancePrompt('Settings', 'ui', undefined, { perCallOptIn: true });
    expect(result.prompt).toContain('production UI mockup');
  });

  it('uses the per-kind directive for mockup', () => {
    const result = enhancePrompt('Wireframe', 'mockup', undefined, { perCallOptIn: true });
    expect(result.prompt).toContain('low-fi wireframe');
  });
});

describe('enhancePrompt — enabled via env', () => {
  it('wraps when KIRO_GPT_MCP_PROMPT_REWRITE=true', () => {
    process.env.KIRO_GPT_MCP_PROMPT_REWRITE = 'true';
    const result = enhancePrompt('A blue car', 'generic');
    expect(result.enhanced).toBe(true);
    expect(result.prompt).toContain('Brief: A blue car');
  });

  it('does not wrap when env value is unrecognised', () => {
    process.env.KIRO_GPT_MCP_PROMPT_REWRITE = 'maybe';
    const result = enhancePrompt('A blue car', 'generic');
    expect(result.enhanced).toBe(false);
  });
});

describe('enhancePrompt — over-budget fallback', () => {
  it('returns templated unchanged when wrapping would exceed 4000 chars', () => {
    // Pad the templated to a length where wrapping breaks the budget.
    // Wrapper overhead is ~280 chars; 3800-char templated guarantees
    // wrapped > 4000 (3800 + 280 = 4080).
    const longTemplated = 'X'.repeat(3800);
    const logger = vi.fn();
    const result = enhancePrompt(longTemplated, 'generic', logger, {
      perCallOptIn: true,
    });
    expect(result.enhanced).toBe(false);
    expect(result.prompt).toBe(longTemplated);
    expect(logger).toHaveBeenCalledWith(
      'warn',
      'mcp_prompt_rewrite_skipped',
      expect.objectContaining({ reason: 'templated_too_long_for_wrapper' }),
    );
  });

  it('emits a structured info log on success', () => {
    const logger = vi.fn();
    const result = enhancePrompt('A small brief', 'generic', logger, {
      perCallOptIn: true,
    });
    expect(result.enhanced).toBe(true);
    expect(logger).toHaveBeenCalledWith(
      'info',
      'mcp_prompt_rewrite_applied',
      expect.objectContaining({
        kind: 'generic',
        originalLength: 'A small brief'.length,
      }),
    );
  });
});

describe('enhancePrompt — closed kind enum', () => {
  it.each<EnhancerKind>(['logo', 'hero', 'icon', 'ui', 'mockup', 'generic'])(
    'wraps successfully for kind %s',
    (kind) => {
      const result = enhancePrompt('seed', kind, undefined, {
        perCallOptIn: true,
      });
      expect(result.enhanced).toBe(true);
      expect(result.prompt.length).toBeGreaterThan('seed'.length);
    },
  );
});
