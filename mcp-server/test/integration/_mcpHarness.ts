/**
 * Test harness for the in-process MCP server integration tests
 * (tasks 23.8, 23.9).
 *
 * Boots a real MCP `Server` with the same tool registry that
 * `mcp-server/src/index.ts` ships and exposes it through a
 * {@link InMemoryTransport} linked pair so a real MCP `Client` can
 * exercise it without spawning a child process.
 *
 * The harness is intentionally NOT exported from a `*.test.ts` file
 * so vitest's `include: ['**\/*.test.ts']` glob never picks it up as
 * a test suite of its own.
 *
 * Implements R31.1 (in-process MCP server), R31.3 (tool registry),
 * R31.7 (RELAY_UNREACHABLE surfaces as a structured tool failure).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  createMcpRelayClient,
  type McpRelayClient,
} from '../../src/relayClient.js';
import {
  createWorkspaceResolver,
  type WorkspaceResolver,
} from '../../src/workspaceResolver.js';
import { generateImage } from '../../src/tools/generateImage.js';
import { generateLogo } from '../../src/tools/generateLogo.js';
import { generateHero } from '../../src/tools/generateHero.js';
import { generateIconSet } from '../../src/tools/generateIconSet.js';
import { generateUiMockup } from '../../src/tools/generateUiMockup.js';
import type { McpToolContext } from '../../src/tools/common.js';

// ─── Public types ─────────────────────────────────────────────────────────

/** Construction options for {@link bootMcpInProcess}. */
export interface BootMcpOptions {
  /** Relay URL the in-process relay client connects to. */
  relayUrl: string;
  /** Workspace root used to resolve tool save paths. */
  workspaceRoot: string;
  /**
   * KIRO_Secret to send in the relay handshake. Defaults to an empty
   * string for tests that do not exercise auth.
   */
  kiroSecret?: string;
  /**
   * When `true`, override the relay client's first-connect backoff
   * sleep with a no-op so a closed-port test does not have to wait
   * the production 1s+2s+4s+8s = 15s schedule. Default false.
   */
  fastBackoff?: boolean;
}

/** Tool result shape exposed by {@link McpHarness.callTool}. */
export interface ToolCallResult {
  /** Parsed `content[0].text` JSON body. */
  payload: Record<string, unknown>;
  /** Whether the SDK marked the result as an error. */
  isError: boolean;
}

/** Public surface of the harness returned by {@link bootMcpInProcess}. */
export interface McpHarness {
  /** Connected MCP client. */
  client: Client;
  /** Connected MCP server. */
  server: Server;
  /** Underlying relay client (for assertions on connection state). */
  relayClient: McpRelayClient;
  /** Workspace resolver injected with the test workspace root. */
  workspaceResolver: WorkspaceResolver;
  /** Whether the lazy connect attempt resolved or rejected. */
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult>;
  /** Idempotent shutdown: closes both transports and the relay socket. */
  cleanup(): Promise<void>;
}

// ─── Tool registry — kept in sync with `mcp-server/src/index.ts` ─────────

/**
 * Schema-only tool catalogue mirroring the production index.ts. The
 * harness only exposes the surface the integration tests touch
 * (`generate_image`); the other entries exist so a future test that
 * exercises `generate_logo` etc. does not have to extend the harness.
 */
const TOOLS = [
  {
    name: 'generate_image',
    description:
      'Generate a generic image via DALL-E and save it to the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        asset_category: { type: 'string' },
        filename: { type: 'string' },
        framework: { type: 'string' },
        workspace_root: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'generate_logo',
    description: 'Generate a brand logo and save it to the workspace.',
    inputSchema: {
      type: 'object',
      properties: { brand_name: { type: 'string' } },
      required: ['brand_name'],
    },
  },
  {
    name: 'generate_hero',
    description: 'Generate a hero banner image and save it to the workspace.',
    inputSchema: {
      type: 'object',
      properties: { scene_description: { type: 'string' } },
      required: ['scene_description'],
    },
  },
  {
    name: 'generate_icon_set',
    description:
      'Generate a coherent icon set (one image per name) sharing a theme.',
    inputSchema: {
      type: 'object',
      properties: {
        theme: { type: 'string' },
        names: { type: 'array', items: { type: 'string' } },
      },
      required: ['theme', 'names'],
    },
  },
  {
    name: 'generate_ui_mockup',
    description:
      'Generate a UI mockup image of the described component and save it.',
    inputSchema: {
      type: 'object',
      properties: { component_description: { type: 'string' } },
      required: ['component_description'],
    },
  },
] as const;

// ─── Boot implementation ──────────────────────────────────────────────────

/**
 * Build a singleton lazy-connect helper that mirrors the
 * `makeLazyConnect` defined in `mcp-server/src/index.ts`. The first
 * tool call awaits the relay client's `connect()` exactly once;
 * subsequent calls re-use the cached promise. On a connect failure
 * the cached promise is cleared so a future tool call retries.
 */
function makeLazyConnect(relayClient: McpRelayClient): () => Promise<void> {
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
        // Connected — leave the cache in place.
      })
      .catch(() => {
        // Connect failed; clear the cache so the next tool call retries.
        pending = null;
      });
    return pending;
  };
}

/**
 * Boot an in-process MCP server, connect a Client to it via an
 * {@link InMemoryTransport} linked pair, and return a
 * {@link McpHarness} for the caller. Idempotent cleanup closes both
 * transports and tears down the relay socket.
 */
export async function bootMcpInProcess(
  opts: BootMcpOptions,
): Promise<McpHarness> {
  const fastSleep: ((ms: number) => Promise<void>) | undefined =
    opts.fastBackoff === true ? () => Promise.resolve() : undefined;

  const relayClient: McpRelayClient = createMcpRelayClient({
    relayUrl: opts.relayUrl,
    kiroSecret: opts.kiroSecret ?? '',
    clientVersion: '0.0.0-test',
    sleep: fastSleep,
  });

  const workspaceResolver: WorkspaceResolver = createWorkspaceResolver({
    env: { KIRO_GPT_MCP_WORKSPACE: opts.workspaceRoot },
  });

  const ctx: McpToolContext = { relayClient, workspaceResolver };
  const connectRelayLazy = makeLazyConnect(relayClient);

  // Build the MCP Server with the same handlers as production.
  const server = new Server(
    { name: 'kiro-gpt-bridge-test', version: '0.0.0-test' },
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
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: !ok,
    };
  });

  // Wire the transports.
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'mcp-harness-client', version: '0.0.0-test' },
    { capabilities: {} },
  );
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  let cleaned = false;
  async function cleanup(): Promise<void> {
    if (cleaned) return;
    cleaned = true;
    try {
      relayClient.disconnect();
    } catch {
      // ignore
    }
    try {
      await client.close();
    } catch {
      // ignore
    }
    try {
      await server.close();
    } catch {
      // ignore
    }
  }

  async function callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const first = raw.content?.[0];
    if (first === undefined || typeof first.text !== 'string') {
      throw new Error('mcp tool result did not include a text content block');
    }
    const payload = JSON.parse(first.text) as Record<string, unknown>;
    return { payload, isError: raw.isError === true };
  }

  return {
    client,
    server,
    relayClient,
    workspaceResolver,
    callTool,
    cleanup,
  };
}
