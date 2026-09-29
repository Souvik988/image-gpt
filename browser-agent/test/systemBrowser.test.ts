/**
 * Unit tests for `resolveSystemBrowser` — the launcher's real-Chrome
 * preference. Google's OAuth refuses automation-flagged Chrome-for-Testing
 * builds; the agent must prefer the user's installed browser when
 * PUPPETEER_EXECUTABLE_PATH is unset.
 */

import { describe, it, expect } from 'vitest';
import { resolveSystemBrowser } from '../src/browser/chromium.js';

describe('resolveSystemBrowser', () => {
  it('returns the first candidate that exists on disk', () => {
    const found = resolveSystemBrowser(['/definitely/missing/chrome', process.execPath]);
    expect(found).toBe(process.execPath);
  });

  it('returns undefined when no candidate exists', () => {
    expect(resolveSystemBrowser(['/definitely/missing/a', '/definitely/missing/b'])).toBeUndefined();
  });

  it('prefers an earlier candidate over a later one', () => {
    const found = resolveSystemBrowser([process.execPath, '/definitely/missing/chrome']);
    expect(found).toBe(process.execPath);
  });
});
