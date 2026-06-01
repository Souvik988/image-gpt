/**
 * Shared in-process boot harness for the workspace-root end-to-end tests
 * (tasks 21.4 and 21.6).
 *
 * Boots a real `relay-server` exactly the way `relay-server/src/index.ts`
 * does — Express app + Socket.IO server, real `Dispatcher`, real
 * `AgentPool`, real `PendingQueue`, real `RequestTable`, real
 * `RateLimiter`, real metric instruments — but binds to ephemeral port
 * 0 instead of the configured port so multiple tests can run in
 * parallel and never collide. The orchestrator's own `index.ts` is not
 * imported because it owns SIGTERM/SIGINT handlers and a top-level
 * `process.exit(...)`; copying the wiring here keeps the test boot
 * pure and tear-down deterministic.
 *
 * Implements the wiring side of tasks 21.4 / 21.6: the tests themselves
 * only have to call {@link bootRelayInProcess} and `await`
 * {@link RelayHarness.shutdown} in `afterAll` for full lifecycle hygiene.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'socket.io';
import {
  EV,
  type AgentId,
  type ClientId,
  type Request,
  type RequestId,
  type RequestStatusEvent,
  type StreamChunk,
} from '@kiro-gpt-bridge/shared';
import { AgentPool, type AgentState } from '../../relay-server/src/dispatch/agentPool.js';
import { PendingQueue } from '../../relay-server/src/dispatch/pendingQueue.js';
import { RequestTable } from '../../relay-server/src/tracking/requestTable.js';
import {
  createDispatcher,
  type Dispatcher,
  type DispatcherTransport,
} from '../../relay-server/src/dispatch/dispatcher.js';
import { createMetrics } from '../../relay-server/src/routes/metrics.js';
import type { HealthProvider } from '../../relay-server/src/routes/health.js';
import type { MetricsProvider } from '../../relay-server/src/routes/metrics.js';
import { createServer, type ServerHandles } from '../../relay-server/src/server.js';
import { createRateLimiter, type RateLimiter } from '../../relay-server/src/auth/rateLimiter.js';
import { attachClientHandlers } from '../../relay-server/src/socket/clientHandlers.js';
import { attachAgentHandlers } from '../../relay-server/src/socket/agentHandlers.js';
import type { RelayConfig } from '../../relay-server/src/config.js';

/**
 * Default secrets used by the harness. Both meet the 16–256 char rule
 * enforced by `loadConfig` and the handshake middleware.
 */
export const HARNESS_KIRO_SECRET = 'test-kiro-secret-1234567890';
export const HARNESS_AGENT_SECRET = 'test-agent-secret-1234567890';

/**
 * Bundle returned by {@link bootRelayInProcess}. Exposes everything a
 * test might need to drive the relay, plus a {@link shutdown} that
 * mirrors the production drain path closely enough for test hygiene
 * (no SIGTERM, no `process.exit`).
 */
export interface RelayHarness {
  /** Bound URL of the relay, e.g. `http://127.0.0.1:54321`. */
  readonly url: string;
  /** Concrete bound port (the OS-allocated ephemeral port). */
  readonly port: number;
  /** Server handles bundle from {@link createServer}. */
  readonly server: ServerHandles;
  /** Live dispatcher; tests can stub timeouts / inspect state. */
  readonly dispatcher: Dispatcher;
  /** Live pending queue; tests can read `size()` / dispose. */
  readonly pendingQueue: PendingQueue;
  /** Live agent pool; tests can read `idle()` / dispose. */
  readonly agentPool: AgentPool;
  /** Live request table — single source of truth for request lifecycle. */
  readonly requestTable: RequestTable;
  /** Live rate limiter — disposed on shutdown. */
  readonly rateLimiter: RateLimiter;
  /**
   * Stop accepting new connections and tear down every owned resource
   * (Socket.IO, HTTP listener, dispatcher timers, queue reaper, agent
   * pool watcher, rate limiter prune timer).
   *
   * Always resolves (never rejects). Idempotent on subsequent calls.
   */
  shutdown(): Promise<void>;
}

/**
 * Boot a real Relay Server instance on an ephemeral port and return a
 * handle the test can drive and tear down deterministically.
 *
 * @param opts.kiroSecret  Optional override; defaults to {@link HARNESS_KIRO_SECRET}.
 * @param opts.agentSecret Optional override; defaults to {@link HARNESS_AGENT_SECRET}.
 */
export async function bootRelayInProcess(
  opts: { kiroSecret?: string; agentSecret?: string } = {},
): Promise<RelayHarness> {
  const config: RelayConfig = {
    port: 0,
    kiroSecret: opts.kiroSecret ?? HARNESS_KIRO_SECRET,
    agentSecret: opts.agentSecret ?? HARNESS_AGENT_SECRET,
    tls: { enabled: false },
    queueMaxDepth: 1000,
  };

  const metrics = createMetrics();
  const agentPool = new AgentPool();
  const pendingQueue = new PendingQueue({ maxDepth: config.queueMaxDepth });
  const requestTable = new RequestTable();
  const rateLimiter = createRateLimiter();

  const clientIdToSocket = new Map<ClientId, Socket>();
  const agentIdToSocket = new Map<AgentId, Socket>();

  const transport: DispatcherTransport = {
    async dispatchToAgent(agent: AgentState, request: Request): Promise<void> {
      const socket = agentIdToSocket.get(agent.agentId);
      if (socket === undefined) {
        throw new Error(`agent socket not registered: ${agent.agentId}`);
      }
      socket.emit(EV.AGENT_DISPATCH, request);
    },
    async cancelToAgent(agent: AgentState, requestId: RequestId): Promise<void> {
      const socket = agentIdToSocket.get(agent.agentId);
      if (socket === undefined) {
        throw new Error(`agent socket not registered: ${agent.agentId}`);
      }
      socket.emit(EV.AGENT_CANCEL, { protocolVersion: 1, requestId });
    },
    emitStatusToClient(clientId: ClientId, event: RequestStatusEvent): void {
      const socket = clientIdToSocket.get(clientId);
      if (socket === undefined) return;
      socket.emit(EV.REQUEST_STATUS, event);
    },
    emitChunkToClient(clientId: ClientId, chunk: StreamChunk): void {
      const socket = clientIdToSocket.get(clientId);
      if (socket === undefined) return;
      socket.emit(EV.STREAM_CHUNK, chunk);
    },
  };

  const dispatcher = createDispatcher({
    agentPool,
    pendingQueue,
    requestTable,
    transport,
  });

  const healthProvider: HealthProvider = {
    uptimeSeconds: () => process.uptime(),
    registeredAgents: () => agentPool.registeredCount(),
    registeredClients: () => clientIdToSocket.size,
    queueDepth: () => pendingQueue.size(),
    allAgentsLoginRequired: (): boolean =>
      agentIdToSocket.size > 0 && agentPool.registeredCount() === 0,
  };
  const metricsProvider: MetricsProvider = {
    queueDepth: () => pendingQueue.size(),
    agentsConnected: () => agentPool.registeredCount(),
  };

  const server = createServer(config, healthProvider, metricsProvider, metrics);

  attachClientHandlers({
    io: server.io,
    kiroSecret: config.kiroSecret,
    rateLimiter,
    dispatcher,
    requestTable,
    registry: {
      registerClient: (socket, clientId): void => {
        clientIdToSocket.set(clientId, socket);
      },
      unregisterClient: (clientId): void => {
        clientIdToSocket.delete(clientId);
      },
      getRegisteredClientCount: (): number => clientIdToSocket.size,
    },
  });
  attachAgentHandlers({
    io: server.io,
    agentSecret: config.agentSecret,
    rateLimiter,
    agentPool,
    dispatcher,
    registry: {
      registerAgent: (socket, agentId): void => {
        agentIdToSocket.set(agentId, socket);
      },
      unregisterAgent: (agentId): void => {
        agentIdToSocket.delete(agentId);
      },
    },
    isAllAgentsLoginRequired: (): boolean =>
      agentIdToSocket.size > 0 && agentPool.registeredCount() === 0,
  });

  // Bind to ephemeral port. `httpServer.listen(0)` lets the OS pick.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.httpServer.removeListener('error', onError);
      reject(err);
    };
    server.httpServer.once('error', onError);
    server.httpServer.listen(0, '127.0.0.1', () => {
      server.httpServer.removeListener('error', onError);
      resolve();
    });
  });

  const addr = server.httpServer.address() as AddressInfo;
  const port = addr.port;
  const url = `http://127.0.0.1:${port}`;

  let disposed = false;
  async function shutdown(): Promise<void> {
    if (disposed) return;
    disposed = true;
    // R1.5 mirror: stop accepting new connections, then tear Socket.IO
    // down. We use drain=0 here because tests prefer a fast tear-down;
    // the spec instruction explicitly calls for `server.shutdown(0)`.
    await server.shutdown(0);
    // Belt-and-braces: explicitly close the HTTP listener too. The
    // `server.shutdown` path already calls `httpServer.close()`, but
    // the spec instruction for these tasks asks for both calls so any
    // leak in the production close path is observable here.
    await new Promise<void>((resolve) => {
      // `close()` on an already-closed server fires its callback with
      // an `Error: Server is not running` — harmless, ignore.
      try {
        (server.httpServer as http.Server).close(() => resolve());
      } catch {
        resolve();
      }
    });
    dispatcher.dispose();
    pendingQueue.dispose();
    agentPool.dispose();
    rateLimiter.dispose();
  }

  return {
    url,
    port,
    server,
    dispatcher,
    pendingQueue,
    agentPool,
    requestTable,
    rateLimiter,
    shutdown,
  };
}
