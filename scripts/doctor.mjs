#!/usr/bin/env node
/**
 * Doctor — one-shot environment health check for the KIRO-GPT Bridge.
 *
 * Verifies, in order:
 *   1. Node.js version (>= 20 required by the workspace tooling).
 *   2. Built artifacts exist (each workspace's dist/index.js).
 *   3. .env / .kiro settings files present (warn — not fatal).
 *   4. Relay /health reachable (when a relay URL is available).
 *
 * Exit code 0 when every hard check passes; 1 on any hard failure.
 * Warnings never affect the exit code.
 *
 * Usage:
 *   node scripts/doctor.mjs
 *   npm run doctor
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';

const IS_WINDOWS = process.platform === 'win32';
const results = [];

function check(name, ok, detail, { hard = true } = {}) {
  results.push({ name, ok, detail, hard });
  const icon = ok ? 'OK  ' : hard ? 'FAIL' : 'WARN';
  console.log(`[${icon}] ${name}${detail ? ` — ${detail}` : ''}`);
}

// ─── 1. Node version ───────────────────────────────────────────────────────

const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
check(
  'node >= 20',
  major >= 20,
  `running ${process.versions.node}`,
);

// ─── 2. Built artifacts ────────────────────────────────────────────────────

const distTargets = [
  'shared/dist/index.js',
  'relay-server/dist/index.js',
  'browser-agent/dist/index.js',
  'mcp-server/dist/index.js',
  'kiro-extension/dist/extension.js',
];
for (const rel of distTargets) {
  const exists = fs.existsSync(path.join(process.cwd(), rel));
  check(`build: ${rel}`, exists, exists ? null : 'run `npm run build`', { hard: false });
}

// ─── 3. Env / settings files ───────────────────────────────────────────────

const envFiles = ['.env', '.kiro/settings/mcp.json'];
for (const rel of envFiles) {
  const exists = fs.existsSync(path.join(process.cwd(), rel));
  check(
    `config: ${rel}`,
    exists,
    exists ? null : 'copy the .example file and fill in your secrets',
    { hard: false },
  );
}

// ─── 4. Relay /health ──────────────────────────────────────────────────────

function readRelayUrl() {
  // Priority: --relay-url arg > .env RELAY_URL? > default localhost:3001.
  const argIdx = process.argv.indexOf('--relay-url');
  if (argIdx !== -1 && process.argv[argIdx + 1]) return process.argv[argIdx + 1];
  try {
    const envText = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
    const m = /RELAY_URL\s*=\s*(\S+)/.exec(envText);
    if (m) return m[1];
  } catch {
    /* no .env — fall through */
  }
  return 'http://localhost:3001';
}

const relayUrl = readRelayUrl();
const healthUrl = relayUrl.replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/$/, '') + '/health';

/** Fetch with a hard 3 s timeout (works on Node 18+ global fetch). */
async function fetchHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const res = await fetch(healthUrl, { signal: controller.signal });
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

try {
  const { ok, status } = await fetchHealth();
  check(`relay /health at ${healthUrl}`, ok, ok ? `HTTP ${status}` : `HTTP ${status}`, {
    hard: false,
  });
} catch (e) {
  check(
    `relay /health at ${healthUrl}`,
    false,
    `unreachable (${e.cause?.code ?? e.name}) — start it with the relay-server README steps`,
    { hard: false },
  );
}

// ─── Summary ───────────────────────────────────────────────────────────────

const hardFailures = results.filter((r) => !r.ok && r.hard);
const warnings = results.filter((r) => !r.ok && !r.hard);
console.log('');
console.log(`Doctor: ${results.length - hardFailures.length - warnings.length}/${results.length} checks passed, ${warnings.length} warning(s).`);
if (hardFailures.length > 0) process.exit(1);
