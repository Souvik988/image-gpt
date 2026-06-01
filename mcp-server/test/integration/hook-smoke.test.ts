/**
 * Smoke test: hook + steering files are valid — task 24.6.
 *
 * Validates the on-disk shape of the visual-asset hooks and steering
 * file shipped under `.kiro/`. The test is intentionally pure I/O —
 * no relay, no MCP server, no socket — because its job is to catch
 * authoring regressions (typos, missing required fields, broken
 * front-matter) before they reach a Kiro runtime.
 *
 * Implements R32.1 (steering file front-matter), R32.4 (file-edited
 * auto-asset hook), R32.5 (post-task spec-asset hook).
 *
 * Files under test (relative to the workspace root):
 *   - .kiro/hooks/generate-missing-assets.kiro.hook
 *   - .kiro/hooks/generate-spec-assets.kiro.hook
 *   - .kiro/steering/visual-assets.md
 *
 * For each hook file the test asserts:
 *   • file exists,
 *   • parses as JSON,
 *   • required keys `name`, `version`, `when`, `then` are present,
 *   • `then.type === 'askAgent'`,
 *   • `then.prompt` is a non-empty string.
 *
 * For the steering file the test asserts:
 *   • front-matter parses with `inclusion: fileMatch`,
 *   • `fileMatchPattern` is a non-empty string,
 *   • body cites both `R32.1` and `R32.2`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

// ─── Workspace-root resolution ─────────────────────────────────────────────

/**
 * Resolve the repository root regardless of where vitest was launched
 * from. The test file lives at `<root>/mcp-server/test/integration/`,
 * so three `..` hops land on the workspace root that owns the
 * `.kiro/` directory.
 */
const WORKSPACE_ROOT: string = path.resolve(__dirname, '..', '..', '..');

const HOOK_FILES: ReadonlyArray<string> = [
  path.join(
    WORKSPACE_ROOT,
    '.kiro',
    'hooks',
    'generate-missing-assets.kiro.hook',
  ),
  path.join(
    WORKSPACE_ROOT,
    '.kiro',
    'hooks',
    'generate-spec-assets.kiro.hook',
  ),
];

const STEERING_FILE: string = path.join(
  WORKSPACE_ROOT,
  '.kiro',
  'steering',
  'visual-assets.md',
);

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Required top-level keys in a `*.kiro.hook` JSON file. Mirrors the
 * authoring contract the Kiro IDE imposes on hook authors.
 */
const REQUIRED_HOOK_KEYS: ReadonlyArray<string> = [
  'name',
  'version',
  'when',
  'then',
];

interface HookFile {
  name: unknown;
  version: unknown;
  when: unknown;
  then: unknown;
  [k: string]: unknown;
}

interface HookThen {
  type: unknown;
  prompt: unknown;
  [k: string]: unknown;
}

/**
 * Type guard that narrows an `unknown` to a non-array, non-null
 * record. Used so the test reports a meaningful failure when a hook
 * file's `then` field is the wrong shape rather than crashing on
 * property access.
 */
function isObjectRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse simple YAML-ish front-matter: a leading `---` line, key/value
 * lines (`key: value`), and a trailing `---` line. The steering file
 * authoring contract is intentionally narrow (string scalars only),
 * so a full YAML parser is overkill here. Returns the parsed map plus
 * the body that follows the closing `---`.
 */
function parseFrontMatter(content: string): {
  frontMatter: Record<string, string>;
  body: string;
} {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    throw new Error('steering file is missing leading --- front-matter');
  }
  const frontMatter: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim() === '---') {
      i += 1;
      break;
    }
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // Strip a single leading/trailing pair of double or single quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontMatter[key] = value;
  }
  const body = lines.slice(i).join('\n');
  return { frontMatter, body };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('hook smoke test — task 24.6', () => {
  describe.each(HOOK_FILES)('hook file %s', (hookPath) => {
    it('exists on disk', () => {
      expect(existsSync(hookPath)).toBe(true);
    });

    it('parses as JSON with required keys', () => {
      const raw = readFileSync(hookPath, 'utf8');
      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(raw);
      }).not.toThrow();
      expect(isObjectRecord(parsed)).toBe(true);
      const hook = parsed as HookFile;
      for (const key of REQUIRED_HOOK_KEYS) {
        expect(hook).toHaveProperty(key);
      }
      expect(typeof hook.name).toBe('string');
      expect((hook.name as string).length).toBeGreaterThan(0);
      expect(typeof hook.version).toBe('string');
      expect((hook.version as string).length).toBeGreaterThan(0);
    });

    it('has then.type === "askAgent" and a non-empty prompt', () => {
      const raw = readFileSync(hookPath, 'utf8');
      const hook = JSON.parse(raw) as HookFile;
      expect(isObjectRecord(hook.then)).toBe(true);
      const then = hook.then as HookThen;
      expect(then.type).toBe('askAgent');
      expect(typeof then.prompt).toBe('string');
      expect((then.prompt as string).trim().length).toBeGreaterThan(0);
    });
  });

  describe('steering file .kiro/steering/visual-assets.md', () => {
    it('exists on disk', () => {
      expect(existsSync(STEERING_FILE)).toBe(true);
    });

    it('has inclusion: fileMatch and a non-empty fileMatchPattern', () => {
      const raw = readFileSync(STEERING_FILE, 'utf8');
      const { frontMatter } = parseFrontMatter(raw);
      expect(frontMatter.inclusion).toBe('fileMatch');
      expect(typeof frontMatter.fileMatchPattern).toBe('string');
      expect((frontMatter.fileMatchPattern ?? '').length).toBeGreaterThan(0);
    });

    it('body cites R32.1 and R32.2', () => {
      const raw = readFileSync(STEERING_FILE, 'utf8');
      const { body } = parseFrontMatter(raw);
      expect(body).toContain('R32.1');
      expect(body).toContain('R32.2');
    });
  });
});
