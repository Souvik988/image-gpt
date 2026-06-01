/**
 * Socket.IO event handlers for Browser Agent connections.
 *
 * Mounted by the orchestrator in `index.ts` after {@link createServer}
 * builds the Socket.IO server and AFTER {@link attachClientHandlers} so
 * the auth middleware order is deterministic. This module owns:
 *
 *  - The handshake-auth middleware (R2.1, R2.2, R2.3) keyed by the
 *    AGENT_SECRET, with the same IP-keyed brute-force tracker (R2.6)
 *    used by the client-side middleware.
 *  - Agent registration (R3.1, R3.5): a fresh {@link AgentId} is
 *    minted on every successful authenticated connection and
 *    advertised back to the agent over `agent.register` so the agent's
 *    relay client can populate its `agentIdValue` field.
 *  - Listeners for `agent.heartbeat` (R3.2, R3.6), `agent.ack`
 *    (R5.5 ack-clear), `stream.chunk` (R6 / R7 routing), and
 *    `agent.status_from` (R23 login_required / ready / restarting).
 *  - Disconnect cleanup that removes the agent from the pool and lets
 *    the dispatcher redispatch any in-flight request (R3.4, R7.8).
 *
 * Wire-schema validation (R26.5, R26.6) is applied to every inbound
 * payload before it touches dispatcher state. R3.6 is the most subtle:
 * a malformed heartbeat is dropped WITHOUT updating the agent's
 * `lastHeartbeatAt`, so the 45 s eviction timer continues to run.
 */

import { randomUUID } from 'node:crypto';
import type { Server as IOServer, Socket } from 'socket.io';
import {
  EV,
  validateAgentHeartbeat,
  validateAgentHandshake,
  validateStreamChunk,
  validateAgentStatusEvent,
  type AgentId,
  type AgentStatus,
  type AgentStatusEvent,
  type ServerStatusEvent,
  type StreamChunk,
} from '@kiro-gpt-bridge/shared';
import { compareSecrets } from '../auth/secret.js';
import type { RateLimiter } from '../auth/rateLimiter.js';
import type { Dispatcher } from '../dispatch/dispatcher.js';
import type { AgentPool } from '../dispatch/agentPool.js';
import { logSafe } from '../log/logger.js';

/**
 * Mirrors the rejection-reason taxonomy in
 * {@link socket/clientHandlers}. The agent's `relayClient.ts`
 * matches `/auth|Authentication|unauthorized/i` so the strings are
 * load-bearing.
 */
const REJECT_REASON = {
  AUTH_FAILED: 'AUTH_FAILED',
  AUTH_RATE_LIMITED: 'AUTH_FAILED: rate_limited',
} as const;

/**
 * Adapter the orchestrator implements so this module can register/
 * deregister agents without coupling to a specific data structure.
 *
 * Implementations must be cheap: every method is on the socket I/O hot
 * path.
 */
export interface AgentRegistry {
  /** Record a successful agent authentication. */
  registerAgent(socket: Socket, agentId: AgentId): void;
  /** Drop the registry entry. */
  unregisterAgent(agentId: AgentId): void;
}

/**
 * Construction options for {@link attachAgentHandlers}.
 */
export interface AgentHandlersDeps {
  /** Live Socket.IO server, built by {@link createServer}. */
  io: IOServer;
  /** Validated AGENT_SECRET from {@link RelayConfig.agentSecret}. */
  agentSecret: string;
  /** IP brute-force tracker — shared with the client-side middleware (R2.6). */
  rateLimiter: RateLimiter;
  /** Agent pool — single source of truth for agent state (R3). */
  agentPool: AgentPool;
  /** Dispatcher — receives `onAgentAck`/`onAgentChunk`/`onAgentDisconnected`/etc. */
  dispatcher: Dispatcher;
  /** Adapter back to the orchestrator's per-agent bookkeeping. */
  registry: AgentRegistry;
  /**
   * Live snapshot used to drive the R23.4 "all agents in login_required"
   * broadcast. The orchestrator owns the canonical agent registry and is
   * the only place that can authoritatively answer this question without
   * coupling this module to a specific data structure.
   *
   * Returns `true` when at least one agent is registered AND every
   * registered agent is currently in `login_required`. Returns `false`
   * when zero agents are registered (a clean empty fleet is not the same
   * as "all locked out") or when at least one agent is dispatch-capable.
   */
  isAllAgentsLoginRequired(): boolean;
}

/**
 * Mint a fresh agent id (R3.5: every (re)connect gets a new id so the
 * dispatcher can never confuse a stale registration with a live one).
 */
function mintAgentId(): AgentId {
  return randomUUID();
}

/**
 * Attach the auth middleware and per-socket listeners for Browser Agent
 * connections to the supplied Socket.IO server.
 *
 * Implements R2.1, R2.2, R2.3, R2.6, R3.1, R3.2, R3.3, R3.4, R3.5,
 * R3.6, R5.5, R7.8, R23.1, R23.2, R23.3, R23.4, R23.5, R23.6, R26.5,
 * R26.6.
 *
 * @param deps See {@link AgentHandlersDeps}.
 */
export function attachAgentHandlers(deps: AgentHandlersDeps): void {
  const { io, agentSecret, rateLimiter, agentPool, dispatcher, registry, isAllAgentsLoginRequired } = deps;

  /**
   * Broadcast a single agent's state transition to every connected
   * client (R23.6). The default Socket.IO namespace's `emit` is the
   * fan-out primitive — we let agent sockets see the broadcast too,
   * because the agent's own relay client ignores `agent.status` events
   * (only the extension subscribes).
   */
  function broadcastAgentStatus(agentId: AgentId, status: AgentStatus): void {
    const event: AgentStatusEvent = {
      protocolVersion: 1,
      kind: 'agent_status',
      agentId,
      status,
    };
    try {
      io.emit(EV.AGENT_STATUS, event);
    } catch (e) {
      logSafe('warn', 'agent_status_broadcast_error', {
        agentId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Broadcast a fleet snapshot (R23.4). Used when every registered
   * agent has just become login_required so the extension can surface a
   * single fleet-wide banner instead of N per-agent toasts.
   */
  function broadcastServerStatus(loginRequiredAll: boolean): void {
    const event: ServerStatusEvent = {
      protocolVersion: 1,
      kind: 'server_status',
      registeredAgents: agentPool.registeredCount(),
      agentsReady: agentPool.idle().length + agentPool.busy().length,
      queueDepth: 0, // queue depth is owned by the dispatcher; clients
      // already track it via the per-request `queued` status. The
      // R23.4 broadcast is purely a `loginRequiredAll` toggle — leave
      // queueDepth conservative-zero here so we never lie about a
      // higher value than the dispatcher actually has.
      loginRequiredAll,
    };
    try {
      io.emit(EV.SERVER_STATUS, event);
    } catch (e) {
      logSafe('warn', 'server_status_broadcast_error', {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ─── Auth middleware (R2.1, R2.2, R2.3, R2.6) ────────────────────────
  // Mirrors `attachClientHandlers`; see the rate-limiter contract notes
  // there for why we run secret-compare → `tryConnect(ip, matches)` once
  // at the end.
  io.use((socket, next) => {
    const ip: string = socket.handshake.address ?? 'unknown';
    const auth = socket.handshake.auth as Record<string, unknown> | undefined;

    // Skip non-agent connections — they were already validated by
    // `attachClientHandlers` (which is mounted first). The discriminator
    // mirrors the one there.
    if (auth === undefined || typeof auth.agentSecret !== 'string') {
      next();
      return;
    }

    const handshake = validateAgentHandshake(auth);
    if (!handshake.ok) {
      const result = rateLimiter.tryConnect(ip, false);
      logSafe('warn', 'agent_auth_rejected', {
        ip,
        reason: 'malformed_handshake',
        firstFailingField: handshake.firstFailingField,
        rule: handshake.rule,
        ...(result.allowed ? {} : { lockedUntil: result.lockedUntil ?? null }),
      });
      next(
        new Error(
          result.allowed ? REJECT_REASON.AUTH_FAILED : REJECT_REASON.AUTH_RATE_LIMITED,
        ),
      );
      return;
    }

    const matches = compareSecrets(handshake.value.agentSecret, agentSecret);
    const result = rateLimiter.tryConnect(ip, matches);
    if (!result.allowed) {
      logSafe('warn', 'agent_auth_rejected', {
        ip,
        reason: matches ? 'rate_limited' : 'bad_secret_or_locked',
        lockedUntil: result.lockedUntil ?? null,
      });
      next(new Error(REJECT_REASON.AUTH_RATE_LIMITED));
      return;
    }
    if (!matches) {
      logSafe('warn', 'agent_auth_rejected', { ip, reason: 'bad_secret' });
      next(new Error(REJECT_REASON.AUTH_FAILED));
      return;
    }

    next();
  });

  // ─── Connection handler ──────────────────────────────────────────────
  io.on('connection', (socket) => {
    const auth = socket.handshake.auth as Record<string, unknown> | undefined;
    // Skip non-agent sockets; their listeners were attached by
    // `attachClientHandlers`. Same discriminator as the auth middleware.
    if (auth === undefined || typeof auth.agentSecret !== 'string') {
      return;
    }

    // R3.1, R3.5 — fresh agent id per connect, registered as idle.
    const agentId: AgentId = mintAgentId();
    try {
      agentPool.register(agentId, socket.id);
    } catch (e) {
      // Defensive: collisions on a UUID v4 are astronomically unlikely
      // but the pool throws on duplicates rather than silently
      // accepting them. Treat as a transient failure.
      logSafe('error', 'agent_register_failed', {
        agentId,
        message: e instanceof Error ? e.message : String(e),
      });
      socket.disconnect(true);
      return;
    }
    registry.registerAgent(socket, agentId);
    logSafe('info', 'agent_connected', {
      agentId,
      ip: socket.handshake.address ?? 'unknown',
    });

    // Advertise the issued agent id back to the agent. The browser
    // agent's `relayClient.ts` blocks on this event before flipping its
    // `isReady()` state to true.
    socket.emit(EV.AGENT_REGISTER, { agentId });

    // R3.2, R3.6 — agent.heartbeat: validate, then update timestamp.
    // Malformed heartbeats are silently dropped without touching
    // `lastHeartbeatAt`, so the 45 s eviction window continues.
    socket.on(EV.AGENT_HEARTBEAT, (raw: unknown) => {
      const result = validateAgentHeartbeat(raw);
      if (!result.ok) {
        logSafe('warn', 'heartbeat_invalid', {
          agentId,
          firstFailingField: result.firstFailingField,
          rule: result.rule,
        });
        return;
      }
      // Use the server-issued agentId, not whatever the agent claimed
      // — a misbehaving agent cannot keep another agent's heartbeat
      // alive by guessing the id.
      agentPool.onHeartbeat(agentId);
    });

    // R5.5 — agent.ack: clear the ack timer for the named request.
    socket.on(EV.AGENT_ACK, (raw: unknown) => {
      // Defensive: accept either `{ requestId: "…" }` or a bare string.
      const requestId = extractAckRequestId(raw);
      if (requestId === null) {
        logSafe('warn', 'ack_invalid', { agentId });
        return;
      }
      dispatcher.onAgentAck(requestId);
    });

    // stream.chunk — validate (R26.5), then route via dispatcher.
    socket.on(EV.STREAM_CHUNK, (raw: unknown) => {
      const result = validateStreamChunk(raw);
      if (!result.ok) {
        logSafe('warn', 'stream_chunk_invalid', {
          agentId,
          firstFailingField: result.firstFailingField,
          rule: result.rule,
        });
        return;
      }
      const chunk: StreamChunk = result.value;
      dispatcher.onAgentChunk(chunk);
    });

    // R23 — agent.status_from: login_required / ready / restarting.
    socket.on(EV.AGENT_STATUS_FROM, (raw: unknown) => {
      const result = validateAgentStatusEvent(raw);
      if (!result.ok) {
        logSafe('warn', 'agent_status_invalid', {
          agentId,
          firstFailingField: result.firstFailingField,
          rule: result.rule,
        });
        return;
      }
      const status = result.value.status;
      logSafe('info', 'agent_status_from', { agentId, status });
      switch (status) {
        case 'login_required':
          // R23.1, R23.2 — mark unavailable; in-flight requests on
          // this agent are redispatched by the dispatcher.
          dispatcher.onAgentLoginRequired(agentId);
          // R23.6 — notify clients of the per-agent transition.
          broadcastAgentStatus(agentId, 'login_required');
          // R23.4 — when EVERY registered agent is now in
          // login_required, broadcast a fleet snapshot so the
          // extension can show a single fleet-wide banner instead of
          // N per-agent toasts.
          if (isAllAgentsLoginRequired()) {
            broadcastServerStatus(true);
          }
          break;
        case 'ready':
          // R23.5, R23.6 — recovery path: move back to idle, drain.
          try {
            agentPool.markReady(agentId);
          } catch {
            // Already idle: nothing to do.
          }
          dispatcher.onAgentReady(agentId);
          // R23.6 — notify clients the agent is back. If this
          // recovery brought the fleet out of "all login_required",
          // also fan out a fresh server snapshot so the banner clears.
          broadcastAgentStatus(agentId, 'ready');
          if (!isAllAgentsLoginRequired()) {
            broadcastServerStatus(false);
          }
          break;
        case 'restarting':
          // Treat the same as login_required for dispatch purposes:
          // mark unavailable so the queue is drained to OTHER agents
          // and the in-flight request on this agent (if any) is
          // redispatched.
          dispatcher.onAgentLoginRequired(agentId);
          broadcastAgentStatus(agentId, 'restarting');
          break;
        case 'busy':
        case 'disconnected':
          // These are server-derived states; an agent should not be
          // pushing them. Log and ignore.
          logSafe('warn', 'agent_status_unexpected', { agentId, status });
          break;
      }
    });

    socket.on('disconnect', (reason: string) => {
      logSafe('info', 'agent_disconnected', { agentId, reason });
      registry.unregisterAgent(agentId);
      // R3.4, R7.8 — drop the agent and let the dispatcher redispatch
      // any in-flight request. `agentPool.disconnect` emits the
      // `agent_disconnected` event the dispatcher subscribed to in its
      // factory, so we do NOT need to also call
      // `dispatcher.onAgentDisconnected` here — that would double-fire
      // the redispatch path. The dispatcher's redispatch path is the
      // one that emits the AGENT_DISCONNECTED failure chunks to the
      // affected clients (R3.4) once the per-request redispatch
      // budget is exhausted.
      try {
        agentPool.disconnect(agentId);
      } catch (e) {
        logSafe('warn', 'agent_disconnect_handler_error', {
          agentId,
          message: e instanceof Error ? e.message : String(e),
        });
      }
      // Notify clients the per-agent state changed so the panel can
      // remove the agent chip. The R3.4 failure-to-client path is
      // owned by the dispatcher (it emits the per-request final
      // chunk); this broadcast is just the fleet status update.
      broadcastAgentStatus(agentId, 'disconnected');
    });
  });
}

/**
 * Best-effort extraction of `requestId` from an `agent.ack` payload.
 * Accepts either the canonical `{ requestId: string }` shape or a bare
 * string for forward-compat with older agent builds.
 *
 * Returns `null` when the payload carries no recognizable request id.
 */
function extractAckRequestId(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (typeof raw === 'object' && raw !== null) {
    const candidate = (raw as { requestId?: unknown }).requestId;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}
