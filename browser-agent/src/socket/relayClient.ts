/**
 * Browser Agent ↔ Relay Server persistent socket client.
 *
 * Implements:
 *  - R3.2  Heartbeat emit every 15 s ± 2 s while connected and registered.
 *  - R11.1 Exponential backoff 1 s → 30 s (doubling, saturating) using
 *          {@link exponentialBackoff} from `@kiro-gpt-bridge/shared`.
 *  - R11.2 Re-auth on every reconnect — the handshake `{ agentSecret,
 *          agentVersion, capabilities }` is sent on EVERY new socket, not
 *          just the first.
 *  - R11.3 Reject incoming dispatches while the agent is not registered
 *          (drops the dispatch and increments the internal drop counter
 *          so the supervisor / metrics layer can observe it).
 *  - R11.6 `connect_error` reason `auth` closes the socket and resumes
 *          backoff (subsequent attempts use an incremented attempt
 *          counter).
 *  - R21.5 Provides the socket plumbing: while disconnected, the agent
 *          emits no chunks / acks / status — outbound emits become drops.
 *          Re-emit on reconnect is handled by the consumer (the agent
 *          FSM in 11.4); this module exposes `onDispatch` / `onCancel`
 *          and `isReady()` so the FSM can implement that policy.
 *
 * Design notes:
 *  - We disable socket.io-client's built-in reconnection
 *    (`reconnection: false`) and own the loop ourselves so the schedule
 *    matches the closed-form requirement of R11.1 verbatim, and so
 *    `connect_error` with reason `auth` (R11.6) is handled identically
 *    to a transport failure: increment the attempt counter, sleep, retry.
 *  - The handshake travels in the Socket.IO `auth` payload. The relay
 *    validates it before emitting `connect`; on failure it sends
 *    `connect_error`.
 *  - The heartbeat uses `setTimeout` recursively rather than
 *    `setInterval` so the ±2 s jitter applies per-tick (R3.2 wording is
 *    "every 15 s ± 2 s", which Property tests interpret as per-emission
 *    jitter).
 *  - `start()` resolves on the FIRST successful registration. Subsequent
 *    disconnects re-trigger `connectLoop()` from inside the `disconnect`
 *    handler so callers see exactly one resolved promise.
 *
 * @packageDocumentation
 */

import { io, type Socket } from 'socket.io-client';
import {
  EV,
  exponentialBackoff,
  type Request,
  type StreamChunk,
  type CancelSignal,
  type AgentStatus,
  type AgentHeartbeat,
  type AgentHandshake,
  type AgentId,
  type ErrorCode,
} from '@kiro-gpt-bridge/shared';
import type { AgentConfig } from '../config.js';
import { logAgentEvent } from '../log/logger.js';

/**
 * Construction options for {@link createRelayClient}.
 *
 * Every external dependency (clock, sleep, socket.io factory) is
 * injectable so unit tests can drive the client deterministically
 * without real timers or sockets.
 */
export interface RelayClientOptions {
  /** Validated agent runtime config (R8.4). Provides relay URL + secret. */
  config: AgentConfig;
  /** Semver of the running browser-agent build, sent in the handshake. */
  agentVersion: string;
  /**
   * Heartbeat interval base in milliseconds. Default 15_000 (R3.2).
   * Per-tick jitter of ±2 s is applied internally.
   */
  heartbeatMs?: number;
  /** Clock injection for tests. Defaults to {@link Date.now}. */
  now?: () => number;
  /**
   * Socket factory injection for tests. Defaults to the real
   * `io(url, opts)` from `socket.io-client`.
   */
  ioFactory?: (url: string, opts: object) => Socket;
  /**
   * Sleep injection for tests. Defaults to a `setTimeout`-based promise.
   */
  sleep?: (ms: number) => Promise<void>;
}

/** Handler invoked when the relay dispatches a {@link Request} to this agent. */
export type RelayDispatch = (request: Request) => void;

/** Handler invoked when the relay forwards a {@link CancelSignal} to this agent. */
export type RelayCancel = (cancel: CancelSignal) => void;

/**
 * Public surface of the relay client. Manages the agent's persistent
 * connection to the relay server, hides reconnect / re-auth / heartbeat
 * details from callers, and exposes a small emit/subscribe API for the
 * agent FSM to plug into.
 *
 * Lifecycle contract:
 *  1. Caller invokes `start()`.
 *  2. The client connects, sends handshake, awaits `agent.register`.
 *  3. `start()` resolves on the FIRST successful registration.
 *  4. Subsequent disconnects trigger background reconnects; `isReady()`
 *     transitions to `false` while disconnected and back to `true` once
 *     re-registered.
 *  5. `stop()` cleanly disconnects and halts the reconnect loop.
 */
export interface RelayClient {
  /**
   * Connect for the first time. Resolves once connected & registered.
   * Reconnect is automatic after this; the returned promise is settled
   * exactly once. Rejection only occurs if `stop()` is called before
   * any successful registration.
   */
  start(): Promise<void>;

  /** Cleanly disconnect and stop the reconnect loop. Idempotent. */
  stop(): void;

  /**
   * True iff the underlying socket is connected AND the relay has
   * issued an `agent.register` payload assigning this agent an
   * {@link AgentId}.
   */
  isReady(): boolean;

  /** Server-issued agentId for the current connection (or `null`). */
  agentId(): AgentId | null;

  /** Subscribe to dispatch events (relay → agent). Multiple handlers allowed. */
  onDispatch(handler: RelayDispatch): void;

  /** Subscribe to cancel signals (relay → agent). Multiple handlers allowed. */
  onCancel(handler: RelayCancel): void;

  /** Emit a stream chunk. No-op (drop counted) when not ready. */
  emitChunk(chunk: StreamChunk): void;

  /**
   * Emit a final-failed {@link StreamChunk} for `requestId` carrying the
   * given closed-enum {@link ErrorCode}. No-op (drop counted) when not
   * ready.
   */
  emitFailure(requestId: string, errorCode: ErrorCode, message?: string): void;

  /**
   * Emit an {@link AgentStatus} update. No-op (drop counted) when not
   * ready, except for `restarting` which is allowed best-effort so the
   * relay learns the agent is intentionally cycling.
   */
  emitStatus(status: AgentStatus, message?: string): void;

  /** Emit an ack for a dispatched request id. No-op (drop counted) when not ready. */
  emitAck(requestId: string): void;

  /** Read accumulated drop counter (tests / supervisor metrics). */
  getDroppedEmitCount(): number;
}

/**
 * Construct a fresh {@link RelayClient}. The returned object owns its
 * own internal socket, attempt counter, heartbeat timer, and handler
 * lists; multiple instances are independent.
 *
 * Implements R3.2, R11.1, R11.2, R11.3, R11.6, R21.5.
 *
 * @param opts See {@link RelayClientOptions}.
 */
export function createRelayClient(opts: RelayClientOptions): RelayClient {
  const config = opts.config;
  const agentVersion = opts.agentVersion;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const ioFactory =
    opts.ioFactory ?? ((url: string, o: object): Socket => io(url, o));

  /** Currently connected socket, or null while reconnecting / stopped. */
  let socket: Socket | null = null;
  /** Current relay-issued agentId, or null while not registered. */
  let agentIdValue: AgentId | null = null;
  /** 1-based attempt counter feeding {@link exponentialBackoff} (R11.1). */
  let attempt = 1;
  /** Set true by `stop()`; gates the reconnect loop. */
  let stopped = false;
  /** Active heartbeat `setTimeout` handle, or null when no tick scheduled. */
  let heartbeatHandle: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic counter of outbound emits dropped because not ready (R11.3). */
  let droppedEmits = 0;
  /** Dispatch subscribers (relay → agent). */
  const dispatchHandlers: RelayDispatch[] = [];
  /** Cancel subscribers (relay → agent). */
  const cancelHandlers: RelayCancel[] = [];

  function isReady(): boolean {
    return socket !== null && socket.connected === true && agentIdValue !== null;
  }

  /**
   * Recursive heartbeat tick. Re-schedules itself with fresh ±2 s
   * jitter every emission (R3.2). No-ops once `stopped` or not ready;
   * the next `connect → register` will restart the chain.
   */
  function startHeartbeat(): void {
    stopHeartbeat();
    const tick = (): void => {
      if (stopped || !isReady()) return;
      // ±2 s uniform jitter applied per-tick (R3.2 wording).
      const jitter = Math.random() * 4_000 - 2_000;
      const hb: AgentHeartbeat = {
        protocolVersion: 1,
        // Safe: isReady() guarantees agentIdValue !== null.
        agentId: agentIdValue as AgentId,
        emittedAt: now(),
      };
      try {
        socket?.emit(EV.AGENT_HEARTBEAT, hb);
        logAgentEvent({ eventType: 'agent.heartbeat_emitted' });
      } catch (e) {
        logAgentEvent({
          eventType: 'agent.error',
          errorCategory: 'heartbeat_emit',
          error: String(e),
        });
      }
      heartbeatHandle = setTimeout(tick, heartbeatMs + jitter);
      heartbeatHandle.unref?.();
    };
    heartbeatHandle = setTimeout(tick, heartbeatMs);
    heartbeatHandle.unref?.();
  }

  function stopHeartbeat(): void {
    if (heartbeatHandle !== null) {
      clearTimeout(heartbeatHandle);
      heartbeatHandle = null;
    }
  }

  /**
   * Outer reconnect loop. Calls {@link connectOnce} until it succeeds
   * (resolves) or `stopped` becomes true. Implements R11.1 / R11.6:
   * every failure — transport or auth — sleeps `exponentialBackoff(n)`
   * and bumps `attempt`; success resets `attempt` to 1.
   */
  async function connectLoop(): Promise<void> {
    while (!stopped) {
      try {
        await connectOnce();
        attempt = 1;
        return;
      } catch (e) {
        const delay = exponentialBackoff(attempt);
        logAgentEvent({
          eventType: 'agent.error',
          errorCategory: 'reconnect',
          error: String(e),
          attempt,
          nextDelayMs: delay,
        });
        await sleep(delay);
        attempt += 1;
      }
    }
  }

  /**
   * One connect+handshake+register attempt. Resolves when the relay
   * emits `agent.register` carrying a valid {@link AgentId}; rejects
   * on any of:
   *  - `connect_error` (R11.6 path: auth failures land here too).
   *  - `disconnect` before registration completes.
   *  - 10 s register-timeout (defensive; tightened by 8.5 once the
   *    relay's exact register payload contract is integration-tested).
   */
  function connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const handshake: AgentHandshake = {
        // R11.2: the secret is sent on every fresh socket, not cached.
        agentSecret: config.agentSecret,
        agentVersion,
        capabilities: { chat: true, image: true },
      };
      const sock = ioFactory(config.relayUrl, {
        // Own the schedule ourselves (R11.1 closed-form requirement).
        reconnection: false,
        // socket.io-client surfaces this object in the server's
        // `handshake.auth`. The relay validates it before `connect`.
        auth: handshake,
        transports: ['websocket'],
      });

      let registerTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      const finish = (err: Error | null): void => {
        if (settled) return;
        settled = true;
        if (registerTimer !== null) {
          clearTimeout(registerTimer);
          registerTimer = null;
        }
        if (err !== null) {
          try {
            sock.removeAllListeners();
            sock.close();
          } catch {
            /* ignore: socket may already be closed */
          }
          reject(err);
        } else {
          resolve();
        }
      };

      sock.on('connect', () => {
        logAgentEvent({ eventType: 'agent.relay_connected' });
      });

      sock.on('connect_error', (err: Error) => {
        // R11.6: auth-fail closes socket and resumes backoff. We treat
        // every `connect_error` the same way (close + reject) — the
        // outer loop's increment + sleep covers both auth and transport
        // failures, satisfying the wording of R11.6 without special-
        // casing the message string. The category log distinguishes
        // them for operators.
        const isAuth =
          /auth|Authentication|unauthorized/i.test(err.message ?? '');
        logAgentEvent({
          eventType: 'agent.error',
          errorCategory: isAuth ? 'auth_failed' : 'connect_error',
          error: err.message,
        });
        finish(isAuth ? new Error(`auth_failed: ${err.message}`) : err);
      });

      sock.on(EV.AGENT_REGISTER, (msg: { agentId: AgentId }) => {
        if (typeof msg?.agentId !== 'string' || msg.agentId.length === 0) {
          finish(new Error('register_invalid_payload'));
          return;
        }
        agentIdValue = msg.agentId;
        socket = sock;
        attachLiveListeners(sock);
        startHeartbeat();
        // Best-effort initial status broadcast. emitStatus checks
        // isReady() internally; at this point socket.connected === true
        // and agentIdValue is set, so it will go out.
        emitStatus('ready');
        finish(null);
      });

      sock.on('disconnect', (reason: string) => {
        logAgentEvent({ eventType: 'agent.relay_disconnected', reason });
        agentIdValue = null;
        stopHeartbeat();
        socket = null;
        if (!settled) {
          // Disconnected before we ever registered: surface as a
          // connect failure so the outer loop sleeps + retries.
          finish(new Error(`disconnect_before_register: ${reason}`));
          return;
        }
        // Already-registered disconnect: kick off a fresh reconnect
        // loop in the background. This is the path the FSM observes
        // via isReady() flipping to false.
        if (!stopped) {
          void connectLoop();
        }
      });

      // Defensive: if `connect` fires but `agent.register` never does,
      // bail out and retry. The 10 s budget mirrors the relay's
      // current register latency target; tighten in 8.5 if needed.
      registerTimer = setTimeout(() => {
        if (agentIdValue === null && sock.connected) {
          logAgentEvent({
            eventType: 'agent.error',
            errorCategory: 'register_timeout',
          });
          finish(new Error('register_timeout'));
        }
      }, 10_000);
      registerTimer.unref?.();
    });
  }

  /**
   * Wire the post-registration listeners (`agent.dispatch`,
   * `agent.cancel`). Kept separate from the connect-phase listeners so
   * the connect promise resolves on registration without leaving stale
   * dispatch handlers attached to a socket that later disconnects
   * before being replaced.
   */
  function attachLiveListeners(sock: Socket): void {
    sock.on(EV.AGENT_DISPATCH, (req: Request) => {
      // R11.3: while not registered, drop the dispatch silently. In
      // practice this branch is unreachable when called from a live
      // socket, but the guard is cheap and protects against races
      // where a delayed packet arrives during `disconnect` cleanup.
      if (!isReady()) {
        droppedEmits += 1;
        return;
      }
      logAgentEvent({
        eventType: 'agent.dispatch_received',
        requestId: req?.requestId,
      });
      for (const h of dispatchHandlers) {
        try {
          h(req);
        } catch (e) {
          logAgentEvent({
            eventType: 'agent.error',
            errorCategory: 'dispatch_handler',
            error: String(e),
            requestId: req?.requestId,
          });
        }
      }
    });

    sock.on(EV.AGENT_CANCEL, (cancel: CancelSignal) => {
      logAgentEvent({
        eventType: 'agent.cancel_received',
        requestId: cancel?.requestId,
      });
      for (const h of cancelHandlers) {
        try {
          h(cancel);
        } catch (e) {
          logAgentEvent({
            eventType: 'agent.error',
            errorCategory: 'cancel_handler',
            error: String(e),
            requestId: cancel?.requestId,
          });
        }
      }
    });
  }

  function emitChunk(chunk: StreamChunk): void {
    if (!isReady()) {
      droppedEmits += 1;
      return;
    }
    socket?.emit(EV.STREAM_CHUNK, chunk);
    if (typeof chunk.chunkIndex === 'number') {
      logAgentEvent({
        eventType: 'agent.stream_chunk_emitted',
        requestId: chunk.requestId,
        chunkIndex: chunk.chunkIndex,
      });
    }
  }

  function emitFailure(
    requestId: string,
    errorCode: ErrorCode,
    message?: string,
  ): void {
    const chunk: StreamChunk = {
      protocolVersion: 1,
      requestId,
      chunkIndex: 0,
      text: '',
      isFinal: true,
      status: 'failed',
      errorCode,
      message,
    };
    emitChunk(chunk);
  }

  function emitStatus(status: AgentStatus, message?: string): void {
    // Best-effort exception: even when not fully ready, allow
    // `restarting` to propagate (R8.x) so the relay learns the agent
    // is intentionally cycling. Other statuses require a registered
    // session.
    if (!isReady() && status !== 'restarting') {
      droppedEmits += 1;
      return;
    }
    if (socket === null || agentIdValue === null) {
      droppedEmits += 1;
      return;
    }
    socket.emit(EV.AGENT_STATUS_FROM, {
      protocolVersion: 1,
      kind: 'agent_status',
      agentId: agentIdValue,
      status,
      message,
    });
  }

  function emitAck(requestId: string): void {
    if (!isReady()) {
      droppedEmits += 1;
      return;
    }
    socket?.emit(EV.AGENT_ACK, { requestId });
  }

  return {
    async start(): Promise<void> {
      await connectLoop();
    },
    stop(): void {
      stopped = true;
      stopHeartbeat();
      if (socket !== null) {
        try {
          socket.close();
        } catch {
          /* ignore: socket may already be closed */
        }
        socket = null;
      }
      agentIdValue = null;
    },
    isReady,
    agentId: (): AgentId | null => agentIdValue,
    onDispatch: (h: RelayDispatch): void => {
      dispatchHandlers.push(h);
    },
    onCancel: (h: RelayCancel): void => {
      cancelHandlers.push(h);
    },
    emitChunk,
    emitFailure,
    emitStatus,
    emitAck,
    getDroppedEmitCount: (): number => droppedEmits,
  };
}
