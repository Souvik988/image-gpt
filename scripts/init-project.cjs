#!/usr/bin/env node
/**
 * Bootstrap kiro-gpt-bridge into a new project.
 *
 * Usage:
 *   node C:\path\to\kirogpt\scripts\init-project.cjs
 *
 * Run this from the ROOT of the project you want to set up. It will:
 *   1. Read the KIRO_SECRET from kirogpt/.env (so secrets stay in one place)
 *   2. Create .kiro/settings/mcp.json registering the five image tools
 *   3. Create .kiro/steering/visual-assets.md with sensible defaults
 *   4. Create .kiro/hooks/generate-missing-assets.kiro.hook
 *   5. Create .kiro/skills/brand-pack-generator.md (manual-trigger workflow)
 *   6. Print next-step instructions
 *
 * Idempotent: re-running merges into existing files where possible and
 * never overwrites your customizations without warning.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Resolve kirogpt repo location ──────────────────────────────────────────

const KIROGPT_ROOT = path.resolve(__dirname, '..');
const KIROGPT_ENV = path.join(KIROGPT_ROOT, '.env');
const PROJECT_ROOT = process.cwd();

if (!fs.existsSync(KIROGPT_ENV)) {
  console.error('[init-project] kirogpt/.env not found at:', KIROGPT_ENV);
  console.error('[init-project] Run this from your project root with the absolute path:');
  console.error('               node ' + path.relative(PROJECT_ROOT, __filename));
  process.exit(1);
}

if (PROJECT_ROOT === KIROGPT_ROOT) {
  console.error('[init-project] Refusing to bootstrap kirogpt into itself.');
  console.error('               cd to your target project root first.');
  process.exit(1);
}

// ─── Parse kirogpt/.env to extract KIRO_SECRET ──────────────────────────────

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    out[k] = v;
  }
  return out;
}

const env = parseEnv(fs.readFileSync(KIROGPT_ENV, 'utf8'));
const KIRO_SECRET = env.KIRO_SECRET || env.KIRO_GPT_MCP_SECRET;
const RELAY_URL = env.RELAY_URL || env.KIRO_GPT_MCP_RELAY_URL || 'ws://localhost:3001';

if (!KIRO_SECRET) {
  console.error('[init-project] KIRO_SECRET not found in kirogpt/.env');
  process.exit(1);
}

// ─── File targets ───────────────────────────────────────────────────────────

const KIRO_DIR = path.join(PROJECT_ROOT, '.kiro');
const SETTINGS_DIR = path.join(KIRO_DIR, 'settings');
const STEERING_DIR = path.join(KIRO_DIR, 'steering');
const HOOKS_DIR = path.join(KIRO_DIR, 'hooks');
const SKILLS_DIR = path.join(KIRO_DIR, 'skills');

const MCP_PATH = path.join(SETTINGS_DIR, 'mcp.json');
const STEERING_PATH = path.join(STEERING_DIR, 'visual-assets.md');
const HOOK_PATH = path.join(HOOKS_DIR, 'generate-missing-assets.kiro.hook');
const SKILL_PATH = path.join(SKILLS_DIR, 'brand-pack-generator.md');

for (const d of [KIRO_DIR, SETTINGS_DIR, STEERING_DIR, HOOKS_DIR, SKILLS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// ─── Helper to write or skip with warning ───────────────────────────────────

function writeOrSkip(target, content) {
  if (fs.existsSync(target)) {
    console.log('[init-project] EXISTS, skipping:', path.relative(PROJECT_ROOT, target));
    return false;
  }
  fs.writeFileSync(target, content);
  console.log('[init-project] CREATED:', path.relative(PROJECT_ROOT, target));
  return true;
}

// ─── 1. mcp.json ────────────────────────────────────────────────────────────

const mcpServerScript = path
  .join(KIROGPT_ROOT, 'mcp-server', 'dist', 'index.js')
  .split(path.sep)
  .join('\\\\');

const projectRootEscaped = PROJECT_ROOT.split(path.sep).join('\\\\');

const mcpJson = {
  mcpServers: {
    'kiro-gpt-bridge': {
      command: 'node',
      args: [path.join(KIROGPT_ROOT, 'mcp-server', 'dist', 'index.js')],
      env: {
        KIRO_GPT_MCP_SECRET: KIRO_SECRET,
        KIRO_GPT_MCP_RELAY_URL: RELAY_URL,
        KIRO_GPT_MCP_WORKSPACE: PROJECT_ROOT,
        KIRO_GPT_MCP_PROMPT_REWRITE: 'true',
      },
      disabled: false,
      autoApprove: [
        'generate_image',
        'generate_logo',
        'generate_hero',
        'generate_icon_set',
        'generate_ui_mockup',
      ],
    },
  },
};

if (fs.existsSync(MCP_PATH)) {
  // Merge: only add kiro-gpt-bridge if not already present.
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(MCP_PATH, 'utf8'));
  } catch (e) {
    console.error('[init-project] mcp.json exists but is not valid JSON; skipping merge.');
    existing = null;
  }
  if (existing && existing.mcpServers && existing.mcpServers['kiro-gpt-bridge']) {
    console.log('[init-project] EXISTS in mcp.json, skipping: kiro-gpt-bridge entry');
  } else if (existing && existing.mcpServers) {
    existing.mcpServers['kiro-gpt-bridge'] = mcpJson.mcpServers['kiro-gpt-bridge'];
    fs.writeFileSync(MCP_PATH, JSON.stringify(existing, null, 2) + '\n');
    console.log('[init-project] MERGED kiro-gpt-bridge into existing mcp.json');
  } else {
    console.error('[init-project] mcp.json had unexpected shape; manual edit needed.');
  }
} else {
  fs.writeFileSync(MCP_PATH, JSON.stringify(mcpJson, null, 2) + '\n');
  console.log('[init-project] CREATED:', path.relative(PROJECT_ROOT, MCP_PATH));
}

// ─── 2. Steering: visual-assets.md ──────────────────────────────────────────

const STEERING_CONTENT = [
  '---',
  'inclusion: always',
  '---',
  '# Visual asset rules',
  '',
  'This project uses **kiro-gpt-bridge** for all generated imagery.',
  '',
  '## Tool routing',
  '',
  '- Logos → `generate_logo`',
  '- Hero / banner images → `generate_hero`',
  '- UI mockups → `generate_ui_mockup`',
  '- Icon sets (matching style) → `generate_icon_set`',
  '- Anything else → `generate_image`',
  '',
  '## Defaults',
  '',
  '- Always pass `enhance_prompt: true` for higher quality.',
  '- Asset folder: `assets/{category}/`. Do not place generated images elsewhere.',
  '- Filenames: kebab-case derived from the brief; never include spaces.',
  '- For UI mockups, prefer viewport `desktop 1440x900` unless the brief specifies otherwise.',
  '',
  '## Quality bar',
  '',
  '- Briefs should be 200–600 characters minimum. Front-load the subject, name a',
  '  concrete style anchor (design system, era, photographer, brand reference),',
  '  specify exact hex colours when relevant, and end with negative anchors',
  '  (no garbled text, no watermark, no signature).',
  '- For dense UI mockups, list every section top to bottom with concrete content.',
  '',
  '## Brand palette (edit this for your project)',
  '',
  '- Primary: #1A1A1A (charcoal)',
  '- Background: #FAFAF7 (warm off-white)',
  '- Accent: #C9512E (terracotta)',
  '- Headlines: refined serif (Editorial New / Reckless)',
  '- Body: clean grotesque (Inter / GT America)',
  '',
].join('\n');

writeOrSkip(STEERING_PATH, STEERING_CONTENT);

// ─── 3. Hook: auto-generate on missing-asset reference ──────────────────────

const HOOK_CONTENT = JSON.stringify(
  {
    name: 'Generate missing assets on save',
    version: '1.0.0',
    description:
      'After saving a component file, scan it for image src paths that do not exist on disk and ask the agent to generate them via kiro-gpt-bridge.',
    when: {
      type: 'fileEdited',
      patterns: [
        '**/*.tsx',
        '**/*.jsx',
        '**/*.vue',
        '**/*.svelte',
        '**/*.html',
      ],
    },
    then: {
      type: 'askAgent',
      prompt:
        'Inspect the saved file for static image references (src="...", url(...), Image, etc.). For every reference whose target does not exist on disk under assets/, call the appropriate kiro-gpt-bridge tool (generate_logo / generate_hero / generate_ui_mockup / generate_image) with enhance_prompt: true and a brief inferred from the surrounding component context. Skip refs whose paths are remote URLs (http, https, data:).',
    },
  },
  null,
  2,
) + '\n';

writeOrSkip(HOOK_PATH, HOOK_CONTENT);

// ─── 4. Skill: brand-pack-generator (manual trigger) ────────────────────────

const SKILL_CONTENT = [
  '---',
  'inclusion: manual',
  '---',
  '# Brand pack generator',
  '',
  'When the user says "generate brand pack for X" or "make brand pack":',
  '',
  '1. Confirm brand name and 2-3 colour preferences if not given.',
  '2. Call `generate_logo` with brand_name = X, enhance_prompt = true.',
  '3. Call `generate_hero` with scene_description matching the brand voice,',
  '   aspect_ratio = "16:9 ultrawide", enhance_prompt = true.',
  '4. Call `generate_icon_set` with theme = "<brand> UI", names = ["search",',
  '   "settings", "user", "cart", "heart", "menu"], enhance_prompt = true.',
  '5. Call `generate_ui_mockup` for the homepage.',
  '6. Summarise saved paths in a markdown table grouped by category.',
  '',
  '## Quality contract',
  '',
  '- Every call uses `enhance_prompt: true`.',
  '- Briefs name concrete style references (design system, era, photographer).',
  '- Palette is enforced via exact hex codes in every brief.',
  '- If any tool call fails, report the failure and continue with the rest;',
  '  do not retry the failed call automatically.',
  '',
].join('\n');

writeOrSkip(SKILL_PATH, SKILL_CONTENT);

// ─── 5. Print next steps ────────────────────────────────────────────────────

console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  kiro-gpt-bridge bootstrapped into:');
console.log('    ' + PROJECT_ROOT);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log('NEXT STEPS:');
console.log('');
console.log('  1. Make sure the relay + agent are running (in the kirogpt repo):');
console.log('       cd ' + KIROGPT_ROOT);
console.log('       start-relay.bat   # leave running');
console.log('       start-agent.bat   # leave running, log into ChatGPT once');
console.log('');
console.log('  2. Reload the Kiro window in this project so the new mcp.json,');
console.log('     steering, hooks, and skill are picked up.');
console.log('     (Ctrl+Shift+P → "Developer: Reload Window")');
console.log('');
console.log('  3. Edit .kiro/steering/visual-assets.md to set YOUR brand palette,');
console.log('     fonts, and any project-specific rules.');
console.log('');
console.log('  4. Ask Kiro: "generate a hero banner of <thing>" — that\'s it.');
console.log('');
