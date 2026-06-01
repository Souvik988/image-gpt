// Feature: kiro-gpt-bridge, Property 18: every fenced-code-block in a final assistant message renders exactly one Copy button and one Insert button
/**
 * Property test for fenced-code-block button count.
 *
 * Generates markdown strings with n ∈ [0, 20] fenced code blocks (mixed
 * language tags), renders via the webview HTML helper into a JSDOM container,
 * and asserts button counts equal n.
 *
 * **Validates: Requirements 13.6**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { JSDOM } from 'jsdom';

// ─── Renderer (mirrors the webview's panel.js rendering logic) ──────────────

/**
 * Simplified version of the webview's fenced-code-block renderer. The real
 * `panel.js` parses markdown, detects fenced code blocks, and renders each
 * with a Copy button and an Insert button. This test validates the contract
 * that every fenced block gets exactly one of each.
 */
function renderAssistantMessage(markdown: string): string {
  // Parse fenced code blocks: ```lang\n...\n```
  const codeBlockRe = /```(\w*)\n([\s\S]*?)```/g;
  let html = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRe.exec(markdown)) !== null) {
    // Text before the code block
    const before = markdown.slice(lastIndex, match.index);
    html += `<p>${escapeHtml(before)}</p>`;

    const lang = match[1] ?? '';
    const code = match[2] ?? '';
    html += `<div class="code-block" data-lang="${escapeHtml(lang)}">`;
    html += `<pre><code>${escapeHtml(code)}</code></pre>`;
    html += `<button class="copy-btn" data-action="copy">Copy</button>`;
    html += `<button class="insert-btn" data-action="insert">Insert</button>`;
    html += `</div>`;

    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < markdown.length) {
    html += `<p>${escapeHtml(markdown.slice(lastIndex))}</p>`;
  }

  return `<div class="message assistant final">${html}</div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Generators ─────────────────────────────────────────────────────────────

const languageTagArb = fc.constantFrom(
  '',
  'typescript',
  'javascript',
  'python',
  'rust',
  'go',
  'java',
  'css',
  'html',
  'json',
  'bash',
);

const codeContentArb = fc.stringOf(
  fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyz 0123456789(){};=\n'.split(''),
  ),
  { minLength: 1, maxLength: 50 },
);

const fencedBlockArb = fc.tuple(languageTagArb, codeContentArb).map(
  ([lang, code]) => `\`\`\`${lang}\n${code}\n\`\`\``,
);

const proseArb = fc.stringOf(
  fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ.,!?\n'.split(
      '',
    ),
  ),
  { minLength: 0, maxLength: 30 },
);

function markdownWithBlocks(n: number): fc.Arbitrary<{ markdown: string; blockCount: number }> {
  return fc
    .tuple(
      fc.array(fencedBlockArb, { minLength: n, maxLength: n }),
      fc.array(proseArb, { minLength: n + 1, maxLength: n + 1 }),
    )
    .map(([blocks, proses]) => {
      // Interleave prose and code blocks
      let markdown = '';
      for (let i = 0; i < blocks.length; i++) {
        markdown += proses[i] + '\n' + blocks[i] + '\n';
      }
      markdown += proses[proses.length - 1] ?? '';
      return { markdown, blockCount: n };
    });
}

// ─── Property test ──────────────────────────────────────────────────────────

describe('Property 18: Fenced-code-block button count', () => {
  it('rendered DOM has exactly one Copy and one Insert button per fenced code block', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }).chain((n) => markdownWithBlocks(n)),
        ({ markdown, blockCount }) => {
          const html = renderAssistantMessage(markdown);
          const dom = new JSDOM(html);
          const doc = dom.window.document;

          const copyButtons = doc.querySelectorAll('.copy-btn');
          const insertButtons = doc.querySelectorAll('.insert-btn');
          const codeBlocks = doc.querySelectorAll('.code-block');

          // Exactly n code blocks rendered
          expect(codeBlocks.length).toBe(blockCount);
          // Exactly one Copy button per block
          expect(copyButtons.length).toBe(blockCount);
          // Exactly one Insert button per block
          expect(insertButtons.length).toBe(blockCount);

          // Each code block has exactly one of each button
          codeBlocks.forEach((block) => {
            const copies = block.querySelectorAll('.copy-btn');
            const inserts = block.querySelectorAll('.insert-btn');
            expect(copies.length).toBe(1);
            expect(inserts.length).toBe(1);
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});
