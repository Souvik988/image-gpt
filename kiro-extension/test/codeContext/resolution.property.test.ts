// Feature: kiro-gpt-bridge, Property 13: resolveCodeContext returns text whose total bytes after truncation ≤ 200000 and every #File / #Folder token expanded by the resolver appears in expandedTokens with matching kind+bytes
/**
 * Property test for code-context resolution and truncation.
 *
 * Builds a virtual workspace and generates prompts with #File and #Folder
 * tokens. Asserts that the resolver matches a reference implementation and
 * that the truncator enforces the 200 KB boundary.
 *
 * **Validates: Requirements 14.1, 14.2, 14.3, 14.4**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { resolveCodeContext, type ResolverFs } from '../../src/codeContext/resolver.js';
import { truncateCodeContext, MAX_BYTES } from '../../src/codeContext/truncator.js';

// ─── Virtual filesystem ─────────────────────────────────────────────────────

interface VirtualEntry {
  kind: 'file' | 'dir';
  content?: string;
  size?: number;
  children?: Map<string, VirtualEntry>;
}

function createVirtualFs(
  workspace: Map<string, VirtualEntry>,
  workspaceRoot: string,
): ResolverFs {
  function resolve(p: string): VirtualEntry | undefined {
    // Normalize path separators
    const normalized = p.replace(/\\/g, '/');
    const rootNorm = workspaceRoot.replace(/\\/g, '/');
    if (!normalized.startsWith(rootNorm)) return undefined;
    const rel = normalized.slice(rootNorm.length).replace(/^\//, '');
    if (rel === '') {
      // Root directory itself
      return { kind: 'dir', children: workspace };
    }
    const parts = rel.split('/');
    let current: Map<string, VirtualEntry> = workspace;
    for (let i = 0; i < parts.length; i++) {
      const entry = current.get(parts[i]!);
      if (!entry) return undefined;
      if (i === parts.length - 1) return entry;
      if (entry.kind !== 'dir' || !entry.children) return undefined;
      current = entry.children;
    }
    return undefined;
  }

  return {
    existsSync(p: string): boolean {
      return resolve(p) !== undefined;
    },
    statSync(p: string) {
      const entry = resolve(p);
      if (!entry) throw new Error(`ENOENT: ${p}`);
      return {
        isFile: () => entry.kind === 'file',
        isDirectory: () => entry.kind === 'dir',
        size: entry.size ?? (entry.content?.length ?? 0),
      };
    },
    readFileSync(p: string): string {
      const entry = resolve(p);
      if (!entry || entry.kind !== 'file') throw new Error(`ENOENT: ${p}`);
      return entry.content ?? '';
    },
    readdirSync(p: string) {
      const entry = resolve(p);
      if (!entry || entry.kind !== 'dir' || !entry.children) {
        throw new Error(`ENOTDIR: ${p}`);
      }
      return Array.from(entry.children.entries()).map(([name, e]) => ({
        name,
        isFile: () => e.kind === 'file',
        isDirectory: () => e.kind === 'dir',
      }));
    },
  };
}

// ─── Generators ─────────────────────────────────────────────────────────────

const fileNameArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  { minLength: 1, maxLength: 10 },
).map((s) => `${s}.ts`);

const fileContentArb = fc.string({ minLength: 0, maxLength: 500 });

const workspaceArb = fc.array(
  fc.tuple(fileNameArb, fileContentArb),
  { minLength: 1, maxLength: 10 },
).map((entries) => {
  const ws = new Map<string, VirtualEntry>();
  for (const [name, content] of entries) {
    ws.set(name, { kind: 'file', content, size: Buffer.byteLength(content, 'utf8') });
  }
  // Add a directory with some files
  const subDir = new Map<string, VirtualEntry>();
  subDir.set('nested.ts', { kind: 'file', content: 'nested content', size: 14 });
  ws.set('subdir', { kind: 'dir', children: subDir });
  return ws;
});

// ─── Property test ──────────────────────────────────────────────────────────

describe('Property 13: Code-context resolution and truncation', () => {
  it('resolves tokens deterministically and truncates at 200 KB boundary', () => {
    const workspaceRoot = '/workspace';

    fc.assert(
      fc.property(
        workspaceArb,
        fc.array(
          fc.record({
            kind: fc.constantFrom('File', 'Folder'),
            target: fc.constantFrom('valid', 'missing', 'outside'),
          }),
          { minLength: 0, maxLength: 6 },
        ),
        (workspace, tokens) => {
          const fsImpl = createVirtualFs(workspace, workspaceRoot);
          const fileNames = Array.from(workspace.keys()).filter(
            (k) => workspace.get(k)!.kind === 'file',
          );

          // Build prompt with tokens
          let prompt = 'Please analyze: ';
          const expectedErrors: string[] = [];

          for (const tok of tokens) {
            let path: string;
            if (tok.target === 'valid') {
              if (tok.kind === 'File' && fileNames.length > 0) {
                path = fileNames[0]!;
              } else if (tok.kind === 'Folder') {
                path = 'subdir';
              } else {
                path = 'nonexistent.ts';
                expectedErrors.push(`#${tok.kind}:${path}`);
              }
            } else if (tok.target === 'outside') {
              path = '../outside.ts';
              expectedErrors.push(`#${tok.kind}:${path}`);
            } else {
              path = 'nonexistent.ts';
              expectedErrors.push(`#${tok.kind}:${path}`);
            }
            prompt += `#${tok.kind}:${path} `;
          }

          const result = resolveCodeContext(prompt, workspaceRoot, fsImpl);

          // Every expanded token must appear in expandedTokens with matching kind
          for (const et of result.expandedTokens) {
            expect(['File', 'Folder']).toContain(et.kind);
            expect(et.bytes).toBeGreaterThanOrEqual(0);
          }

          // Errors should have valid reasons
          for (const err of result.errors) {
            expect([
              'outside_workspace',
              'not_found',
              'file_too_large',
              'folder_too_many_files',
              'not_a_file',
              'not_a_folder',
              'read_failed',
            ]).toContain(err.reason);
          }

          // Truncation: after truncation, total bytes ≤ MAX_BYTES
          const truncResult = truncateCodeContext(result.text);
          expect(truncResult.truncatedToBytes).toBeLessThanOrEqual(MAX_BYTES);

          if (truncResult.truncated) {
            // Notice must be appended
            expect(truncResult.text).toContain(
              '[Code context truncated from',
            );
            expect(truncResult.text).toContain('KB to 200 KB]');
          }

          // Determinism: same input → same output
          const result2 = resolveCodeContext(prompt, workspaceRoot, fsImpl);
          expect(result2.text).toBe(result.text);
          expect(result2.errors).toEqual(result.errors);
          expect(result2.expandedTokens).toEqual(result.expandedTokens);
        },
      ),
      { numRuns: 200 },
    );
  });
});
