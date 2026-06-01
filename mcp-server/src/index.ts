#!/usr/bin/env node
/**
 * stdio MCP server entry point for `kiro-gpt-bridge`.
 *
 * Implements:
 *  - R31.1 — separate Node process speaking MCP over stdio per the
 *    Model Context Protocol specification.
 *  - R31.2 — connects to the Relay_Server using `KIRO_GPT_MCP_SECRET`
 *    as a KIRO_Client; the connection is established lazily on the
 *    first tool call so the stdio loop stays alive even when the relay
 *    is not reachable at boot.
 *  - R31.3 — registers the five MCP tools (`generate_image`,
 *    `generate_logo`, `generate_hero`, `generate_icon_set`,
 *    `generate_ui_mockup`) from `./tools/*.ts`.
 *  - R31.4 — every tool builds its prompt from a versioned template
 *    (see `./promptTemplates.ts`) before forwarding the image Request
 *    to the relay.
 *  - R31.5 / R31.7 — workspace resolution + `RELAY_UNREACHABLE` /
 *    `WORKSPACE_REQUIRED` surfaced as structured tool failures rather
 *    than crashing the stdio loop.
 *  - R30.8 — every diagnostic line is structured JSON to stderr so the
 *    `origin: "mcp"` field reaches downstream log aggregators (stdout
 *    is reserved for MCP protocol traffic).
 *
 * Boot order:
 *   1. Read env vars `KIRO_GPT_MCP_SECRET` (R31.2) and
 *      `KIRO_GPT_MCP_RELAY_URL` (defaults to `ws://localhost:3001`).
 *      Warn — do not exit — on missing secret so an MCP host can still
 *      boot the process to inspect tool listings; tool calls will then
 *      surface `RELAY_UNREACHABLE` per R31.7.
 *   2. Build the relay client and the workspace resolver. Do NOT
 *      connect the relay client yet.
 *   3. Build the MCP `Server` and register `tools/list` + `tools/call`.
 *   4. Connect the MCP server to a `StdioServerTransport`.
 *   5. Wire SIGINT, SIGTERM, and stdin-close handlers so the relay
 *      socket is closed and any in-flight `submitAndAwait` promises
 *      reject with `mcp_relay_disconnected` on shutdown.
 *
 * Lazy relay connect: the first tool call awaits a singleton
 * {@link connectRelayLazy} helper that calls `relayClient.connect()`
 * exactly once. Subsequent calls re-use the same promise, so the
 * connection happens at most once per process lifetime regardless of
 * how many tool calls race the cold start.
 *
 * The bin works on POSIX via the `#!/usr/bin/env node` shebang above;
 * Windows resolves the bin via the `bin` field in `package.json` which
 * generates a `.cmd` shim during install.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { createMcpRelayClient, type McpRelayClient } from './relayClient.js';
import { createWorkspaceResolver } from './workspaceResolver.js';
import { generateImage } from './tools/generateImage.js';
import { generateLogo } from './tools/generateLogo.js';
import { generateHero } from './tools/generateHero.js';
import { generateIconSet } from './tools/generateIconSet.js';
import { generateUiMockup } from './tools/generateUiMockup.js';
import type { McpToolContext } from './tools/common.js';

// ─── Constants ─────────────────────────────────────────────────────────────

/** Server name advertised in the MCP `initialize` response. */
const SERVER_NAME = 'kiro-gpt-bridge';
/**
 * Server version advertised in the MCP `initialize` response. Matches
 * the workspace placeholder version 0.0.0 until the project ships.
 */
const SERVER_VERSION = '0.0.0';
/** Default relay URL when `KIRO_GPT_MCP_RELAY_URL` is unset. */
const DEFAULT_RELAY_URL = 'ws://localhost:3001';

// ─── Logging helpers ───────────────────────────────────────────────────────

/**
 * Emit a structured JSON log line to stderr. Stdout is reserved for the
 * MCP protocol, so every diagnostic must go to stderr (R30.8).
 */
function log(
  level: 'info' | 'error' | 'warn',
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    origin: 'mcp',
    ...fields,
  });
  // eslint-disable-next-line no-console
  console.error(line);
}

// ─── Tool registry ─────────────────────────────────────────────────────────

/**
 * Static tool catalog returned by `tools/list`. Each entry mirrors the
 * R31.3 surface: required fields, optional fields, and a one-liner
 * description for the agent.
 */
const TOOLS = [
  {
    name: 'generate_image',
    description:
      'Generate a generic image via DALL-E and save it to the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 4000 },
        asset_category: {
          type: 'string',
          enum: [
            'logo',
            'hero',
            'icon',
            'illustration',
            'background',
            'mockup',
            'other',
          ],
        },
        filename: { type: 'string' },
        framework: {
          type: 'string',
          enum: [
            'next',
            'nuxt',
            'sveltekit',
            'vite',
            'angular',
            'cra',
            'unknown',
          ],
        },
        workspace_root: { type: 'string' },
        overwrite: { type: 'boolean' },
        enhance_prompt: { type: 'boolean' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_logo',
    description: 'Generate a brand logo and save it to the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        brand_name: { type: 'string', minLength: 1 },
        style: { type: 'string' },
        color_palette: { type: 'string' },
        framework: {
          type: 'string',
          enum: [
            'next',
            'nuxt',
            'sveltekit',
            'vite',
            'angular',
            'cra',
            'unknown',
          ],
        },
        workspace_root: { type: 'string' },
        overwrite: { type: 'boolean' },
        enhance_prompt: { type: 'boolean' },
      },
      required: ['brand_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_hero',
    description: 'Generate a hero banner image and save it to the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        scene_description: { type: 'string', minLength: 1 },
        aspect_ratio: { type: 'string' },
        framework: {
          type: 'string',
          enum: [
            'next',
            'nuxt',
            'sveltekit',
            'vite',
            'angular',
            'cra',
            'unknown',
          ],
        },
        workspace_root: { type: 'string' },
        overwrite: { type: 'boolean' },
        enhance_prompt: { type: 'boolean' },
      },
      required: ['scene_description'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_icon_set',
    description:
      'Generate a coherent icon set (one image per name) sharing a theme.',
    inputSchema: {
      type: 'object',
      properties: {
        theme: { type: 'string', minLength: 1 },
        names: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
        },
        style: { type: 'string' },
        framework: {
          type: 'string',
          enum: [
            'next',
            'nuxt',
            'sveltekit',
            'vite',
            'angular',
            'cra',
            'unknown',
          ],
        },
        workspace_root: { type: 'string' },
        overwrite: { type: 'boolean' },
        enhance_prompt: { type: 'boolean' },
      },
      required: ['theme', 'names'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_ui_mockup',
    description:
      'Generate a UI mockup image of the described component and save it.',
    inputSchema: {
      type: 'object',
      properties: {
        component_description: { type: 'string', minLength: 1 },
        framework: {
          type: 'string',
          enum: [
            'next',
            'nuxt',
            'sveltekit',
            'vite',
            'angular',
            'cra',
            'unknown',
          ],
        },
        viewport: { type: 'string' },
        workspace_root: { type: 'string' },
        overwrite: { type: 'boolean' },
        enhance_prompt: { type: 'boolean' },
      },
      required: ['component_description'],
      additionalProperties: false,
    },
  },
] as const;

// ─── Lazy relay connect ────────────────────────────────────────────────────

/**
 * Build a singleton lazy-connect helper. The returned function calls
 * `relayClient.connect()` at most once and caches the resulting promise
 * so concurrent tool calls share a single connect attempt.
 *
 * On a connect failure the cached promise is cleared so a subsequent
 * tool call gets a fresh attempt — this matches R31.7's expectation
 * that `RELAY_UNREACHABLE` is recoverable when the relay later starts.
 */
function makeLazyConnect(
  relayClient: McpRelayClient,
  relayUrl: string,
): () => Promise<void> {
  let pending: Promise<void> | null = null;
  return (): Promise<void> => {
    if (relayClient.isConnected()) {
      return Promise.resolve();
    }
    if (pending !== null) {
      return pending;
    }
    pending = relayClient
      .connect()
      .then(() => {
        log('info', 'mcp_relay_connected', { relayUrl });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log('error', 'mcp_relay_unreachable', { relayUrl, message });
        // Clear the cache so the next tool call retries.
        pending = null;
        // Swallow the rejection — tool handlers detect connection state
        // via `relayClient.isConnected()` and produce RELAY_UNREACHABLE
        // themselves (R31.7).
      });
    return pending;
  };
}

// ─── Boot ─────────────────────────────────────────────────────────────────

/**
 * Boot the MCP stdio server. This function is the single side-effecting
 * entry point invoked by the `#!/usr/bin/env node` shebang at the top
 * of the file.
 */
async function main(): Promise<void> {
  // 1. Read env vars (R31.2).
  //    `KIRO_GPT_MCP_SECRET` — KIRO_Secret used in the relay handshake.
  //    `KIRO_GPT_MCP_RELAY_URL` — relay URL (defaults to localhost).
  //    Per the task description, MISSING SECRET WARNS rather than exits
  //    so an MCP host can still inspect `tools/list`. Tool calls will
  //    then surface `RELAY_UNREACHABLE` (R31.7).
  const kiroSecret: string = process.env.KIRO_GPT_MCP_SECRET ?? '';
  const relayUrl: string =
    process.env.KIRO_GPT_MCP_RELAY_URL ?? DEFAULT_RELAY_URL;
  if (kiroSecret.length === 0) {
    log('warn', 'mcp_secret_missing', {
      message:
        'KIRO_GPT_MCP_SECRET is not set; relay handshake will fail and tool calls will return RELAY_UNREACHABLE',
    });
  }

  // 2. Build the relay client and workspace resolver. The relay client
  //    is NOT connected yet — connect runs lazily on the first tool
  //    call so the stdio loop is not blocked on relay availability.
  const relayClient = createMcpRelayClient({
    relayUrl,
    kiroSecret,
    clientVersion: SERVER_VERSION,
  });
  const workspaceResolver = createWorkspaceResolver();
  const ctx: McpToolContext = { relayClient, workspaceResolver };
  const connectRelayLazy = makeLazyConnect(relayClient, relayUrl);

  // 3. Build the MCP server and wire `tools/list` + `tools/call`.
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({ tools: TOOLS as unknown as Array<{ name: string }> }),
  );

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const params = req.params as { name?: string; arguments?: unknown };
    const toolName: string = typeof params.name === 'string' ? params.name : '';
    const args: Record<string, unknown> =
      typeof params.arguments === 'object' && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {};

    // Lazy-connect the relay on the first tool call. The connect
    // promise resolves whether or not the connection succeeded; tool
    // handlers detect failure via `relayClient.isConnected()` and
    // return RELAY_UNREACHABLE (R31.7).
    await connectRelayLazy();

    let result: unknown;
    switch (toolName) {
      case 'generate_image':
        result = await generateImage(args, ctx);
        break;
      case 'generate_logo':
        result = await generateLogo(args, ctx);
        break;
      case 'generate_hero':
        result = await generateHero(args, ctx);
        break;
      case 'generate_icon_set':
        result = await generateIconSet(args, ctx);
        break;
      case 'generate_ui_mockup':
        result = await generateUiMockup(args, ctx);
        break;
      default:
        log('warn', 'mcp_unknown_tool', { tool: toolName });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                errorCode: 'SCHEMA_INVALID',
                message: `unknown tool: ${toolName}`,
              }),
            },
          ],
          isError: true,
        };
    }

    const ok = (result as { ok?: unknown }).ok === true;
    log(ok ? 'info' : 'error', 'mcp_tool_result', {
      tool: toolName,
      ok,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: !ok,
    };
  });

  // 4. Connect the MCP server to its stdio transport.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', 'mcp_stdio_ready', {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // 5. Graceful shutdown. SIGINT/SIGTERM and stdin-close all funnel
  //    through a single idempotent shutdown helper that closes the
  //    relay socket (rejecting any in-flight `submitAndAwait`
  //    promises) and then exits 0.
  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'mcp_shutdown', { reason });
    try {
      relayClient.disconnect();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('error', 'mcp_shutdown_relay_error', { message });
    }
    // Allow the final log line to flush before exiting.
    setTimeout(() => process.exit(0), 0).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.stdin.on('close', () => shutdown('stdin_closed'));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  log('error', 'mcp_unhandled_error', { message });
  process.exit(1);
});
