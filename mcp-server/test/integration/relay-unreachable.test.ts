/**
 * Integration test: MCP `RELAY_UNREACHABLE` — task 23.9.
 *
 * Boots the MCP server with a relay URL pointing at a closed port and
 * calls `generate_image` via the in-process MCP transport. The
 * underlying `McpRelayClient` will exhaust its first-connect retry
 * budget, the lazy-connect helper will swallow the rejection, and the
 * tool's `ensureConnected` guard will surface
 * `{ ok: false, errorCode: 'RELAY_UNREACHABLE', message }` per
 * R31.7. The test additionally walks the temp workspace tree and
 * asserts that no file was written anywhere under it.
 *
 * Implements R31.7.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';

import { bootMcpInProcess, type McpHarness } from './_mcpHarness.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Acquire a TCP port that is guaranteed to be closed by the time this
 * function returns. Listens on `127.0.0.1:0`, captures the
 * OS-assigned port, then closes the listener so a subsequent connect
 * attempt is sure to fail with ECONNREFUSED.
 */
function getClosedPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('failed to acquire port'));
        return;
      }
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Recursively count regular files under `root`. Used to assert that
 * the failed tool call did not write anywhere under the test
 * workspace. Returns 0 when `root` does not exist.
 */
function countFilesUnder(root: string): number {
  let count = 0;
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      count += countFilesUnder(full);
    } else if (entry.isFile()) {
      count += 1;
    } else if (entry.isSymbolicLink()) {
      try {
        const s = statSync(full);
        if (s.isFile()) count += 1;
      } catch {
        // dangling symlink — ignore
      }
    }
  }
  return count;
}

// ─── Fixture ───────────────────────────────────────────────────────────────

let workspaceRoot: string;
let harness: McpHarness;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'mcp-unreachable-'));
  const port = await getClosedPort();
  harness = await bootMcpInProcess({
    relayUrl: `ws://127.0.0.1:${port}`,
    workspaceRoot,
    fastBackoff: true,
  });
}, 30_000);

afterAll(async () => {
  if (harness !== undefined) {
    await harness.cleanup();
  }
  if (workspaceRoot !== undefined) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('MCP RELAY_UNREACHABLE — task 23.9', () => {
  it('returns errorCode RELAY_UNREACHABLE and writes no file', async () => {
    const result = await harness.callTool('generate_image', {
      prompt: 'test prompt for an unreachable relay',
    });

    expect(result.isError).toBe(true);
    expect(result.payload.ok).toBe(false);
    expect(result.payload.errorCode).toBe('RELAY_UNREACHABLE');
    expect(typeof result.payload.message).toBe('string');
    expect((result.payload.message as string).length).toBeGreaterThan(0);

    // No file should have been written anywhere under the workspace.
    expect(countFilesUnder(workspaceRoot)).toBe(0);

    // The relay client must report disconnected.
    expect(harness.relayClient.isConnected()).toBe(false);
  }, 30_000);
});
