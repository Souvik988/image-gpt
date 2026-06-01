/**
 * End-to-end smoke test — task 21.4.
 *
 * Boots a real `relay-server` in-process via {@link bootRelayInProcess},
 * connects a mock browser-agent over real `socket.io-client`, and a
 * real {@link ExtensionRelayClient} from the `kiro-extension/` package.
 * Submits a chat request through the extension client, has the mock
 * agent stream chunks back, and asserts the extension receives the
 * final chunk carrying the same fully-assembled text.
 *
 * What this test exercises end-to-end:
 *  - Client handshake auth (KIRO_SECRET) — the real extension client
 *    is admitted by the real relay middleware.
 *  - Agent handshake auth (AGENT_SECRET) — the mock agent connects and
 *    receives a server-issued `agentId` over `agent.register`.
 *  - Idle-first dispatch (R5.1, R5.5) — `request.submit` from the
 *    extension reaches the agent as `agent.dispatch`.
 *  - Chunk routing to originating client (R7.4 chunk fan-out) — every
 *    `stream.chunk` the agent emits is delivered to the submitting
 *    client and only that client.
 *  - Terminal `completed` chunk (R7.6) — the extension sees the final
 *    chunk and the request's local record is removed from `inflight`.
 *
 * Tear-down per the spec instruction: `server.shutdown(0)` followed by
 * `httpServer.close()`. Both are wrapped in {@link RelayHarness.shutdown}.
 *
 * _Implements: R5.1, R5.5_
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import {
  EV,
  type Request,
  type StreamChunk,
  type AgentHandshake,
  type AgentHeartbeat,
} from '@kiro-gpt-bridge/shared';
import {
  createRelayClient,
  type ExtensionRelayClient,
} from '../../kiro-extension/src/relay/relayClient.js';
import {
  bootRelayInProcess,
  HARNESS_AGENT_SECRET,
  HARNESS_KIRO_SECRET,
  type RelayHarness,
} from './harness.js';

/**
 * Wait helper — returns a promise that resolves once `predicate()` is
 * truthy or `timeoutMs` elapses. Polls every 10 ms which is plenty fast
 * for socket round-trips on localhost.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 10);
      t.unref?.();
    });
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs} ms`);
}

/**
 * Minimal mock browser-agent built on real `socket.io-client`. Connects
 * to the relay with the agent secret, captures the server-issued
 * `agentId`, listens for `agent.dispatch`, streams a sequence of
 * partial chunks followed by a final chunk with the requested text, and
 * supports cooperative shutdown.
 */
interface MockAgent {
  /** Resolves once the agent has received its `agentId` from the server. */
  ready(): Promise<void>;
  /** Disconnect the agent socket. Idempotent. */
  close(): void;
  /** Last received {@link Request} from the relay, if any. */
  lastDispatchedRequest(): Request | null;
  /** Number of chunks emitted by this agent. */
  emittedChunkCount(): number;
}

/**
 * Build and connect a mock browser-agent. The agent will, for each
 * dispatched request:
 *   1. Send a single-chunk acknowledgement (agent.ack — not used by the
 *      dispatcher transport in this test, but mirrors production).
 *   2. Emit `partials.length` partial chunks.
 *   3. Emit one final chunk whose `text` is the full assembled string,
 *      carrying `isFinal: true` and `status: 'completed'`.
 */
function createMockAgent(opts: {
  url: string;
  agentSecret: string;
  partials: readonly string[];
}): MockAgent {
  const handshake: AgentHandshake = {
    agentSecret: opts.agentSecret,
    agentVersion: '0.0.0-mock',
    capabilities: { chat: true, image: true },
  };
  const sock: ClientSocket = ioClient(opts.url, {
    auth: handshake as unknown as Record<string, unknown>,
    reconnection: false,
    transports: ['websocket'],
    timeout: 10_000,
  });

  let agentId: string | null = null;
  let lastDispatched: Request | null = null;
  let emittedChunks = 0;
  const readyResolvers: Array<() => void> = [];

  sock.on(EV.AGENT_REGISTER, (payload: { agentId?: string }) => {
    if (typeof payload?.agentId === 'string') {
      agentId = payload.agentId;
      while (readyResolvers.length > 0) {
        const r = readyResolvers.shift();
        if (r) r();
      }
    }
  });

  // Production agents emit a heartbeat every ~15 s (R3.2). The mock
  // sends one immediately on connect so the agent pool's
  // `lastHeartbeatAt` is updated, then relies on the relay's 45 s
  // heartbeat-miss window — well past any reasonable test runtime.
  sock.on('connect', () => {
    if (agentId !== null) {
      const hb: AgentHeartbeat = {
        protocolVersion: 1,
        agentId,
        emittedAt: Date.now(),
      };
      sock.emit(EV.AGENT_HEARTBEAT, hb);
    }
  });

  sock.on(EV.AGENT_DISPATCH, (request: Request) => {
    lastDispatched = request;

    // Acknowledge dispatch so the relay clears its 5 s ack timer.
    sock.emit(EV.AGENT_ACK, { requestId: request.requestId });

    // Stream partial chunks, then a final assembled chunk.
    let assembled = '';
    let chunkIndex = 0;
    for (const piece of opts.partials) {
      assembled += piece;
      const partial: StreamChunk = {
        protocolVersion: 1,
        requestId: request.requestId,
        chunkIndex,
        text: piece,
        isFinal: false,
      };
      sock.emit(EV.STREAM_CHUNK, partial);
      emittedChunks += 1;
      chunkIndex += 1;
    }

    const finalChunk: StreamChunk = {
      protocolVersion: 1,
      requestId: request.requestId,
      chunkIndex,
      text: assembled,
      isFinal: true,
      status: 'completed',
    };
    sock.emit(EV.STREAM_CHUNK, finalChunk);
    emittedChunks += 1;
  });

  return {
    ready: (): Promise<void> =>
      new Promise<void>((resolve) => {
        if (agentId !== null) {
          resolve();
          return;
        }
        readyResolvers.push(resolve);
      }),
    close: (): void => {
      try {
        sock.removeAllListeners();
        sock.disconnect();
      } catch {
        // already closed
      }
    },
    lastDispatchedRequest: (): Request | null => lastDispatched,
    emittedChunkCount: (): number => emittedChunks,
  };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────

let harness: RelayHarness;
let agent: MockAgent;
let extension: ExtensionRelayClient;

const PARTIALS: readonly string[] = ['Hello', ', ', 'World', '!'];
const EXPECTED_TEXT: string = PARTIALS.join('');

beforeAll(async () => {
  harness = await bootRelayInProcess();
  agent = createMockAgent({
    url: harness.url,
    agentSecret: HARNESS_AGENT_SECRET,
    partials: PARTIALS,
  });
  await agent.ready();

  extension = createRelayClient({
    relayUrl: harness.url,
    kiroSecret: HARNESS_KIRO_SECRET,
    clientVersion: '0.0.0-test',
  });
  await extension.start();
});

afterAll(async () => {
  try {
    extension.stop();
  } catch {
    // best-effort
  }
  try {
    agent.close();
  } catch {
    // best-effort
  }
  await harness.shutdown();
});

// ─── Test ─────────────────────────────────────────────────────────────────

describe('e2e smoke (task 21.4)', () => {
  it('extension receives the final chunk with the same fully-assembled text', async () => {
    const finalChunks: StreamChunk[] = [];
    const allChunks: StreamChunk[] = [];
    extension.onStreamChunk((chunk) => {
      allChunks.push(chunk);
      if (chunk.isFinal) {
        finalChunks.push(chunk);
      }
    });

    const requestId: string = randomUUID();
    const request: Request = {
      protocolVersion: 1,
      requestId,
      // The relay overrides whatever clientId the client supplies (R4.4)
      // so this value is ignored on the server side; we still set it to
      // satisfy the wire schema's `clientId: z.string().min(1)` rule.
      clientId: 'extension-client-stub',
      sessionId: randomUUID(),
      type: 'chat',
      prompt: 'Greet the world',
      submittedAt: Date.now(),
    };

    extension.submit(request);

    // Wait for the final chunk to land on the extension. 5 s is well
    // beyond any localhost socket round-trip; if we don't see it the
    // dispatcher transport, agent dispatch, or chunk routing is broken.
    await waitFor(() => finalChunks.length > 0, 5_000, 'final-chunk');

    // The mock agent must have actually been dispatched to.
    const dispatched = agent.lastDispatchedRequest();
    expect(dispatched).not.toBeNull();
    expect(dispatched?.requestId).toBe(requestId);
    expect(dispatched?.type).toBe('chat');
    expect(dispatched?.prompt).toBe('Greet the world');

    // The single final chunk the extension observed must carry the
    // full assembled text — the assertion the spec instruction
    // explicitly calls out.
    const finalChunk = finalChunks[0];
    expect(finalChunk).toBeDefined();
    expect(finalChunk?.requestId).toBe(requestId);
    expect(finalChunk?.isFinal).toBe(true);
    expect(finalChunk?.status).toBe('completed');
    expect(finalChunk?.text).toBe(EXPECTED_TEXT);

    // The terminal chunk removed the record from the extension's
    // inflight map (relayClient.handleStreamChunk on isFinal:true).
    expect(extension.getInflight().some((r) => r.request.requestId === requestId)).toBe(false);

    // Every chunk routed to this client must reference *this* request
    // (R7.4 — chunks fan out only to the originating client). Because
    // there is exactly one client in this harness we can additionally
    // assert that no foreign requestIds leaked through.
    for (const chunk of allChunks) {
      expect(chunk.requestId).toBe(requestId);
    }
    expect(agent.emittedChunkCount()).toBe(PARTIALS.length + 1);
  });
});
