/**
 * KIRO Extension ↔ Relay Server Socket.IO client.
 *
 * Wraps `socket.io-client` with a custom backoff schedule (R21.1) and an
 * in-memory `inflight` map of every non-terminal Request that the
 * extension has submitted. On every reconnect after the first success the
 * client re-emits each non-terminal Request so the relay can resume work
 * (R21.3) — the relay deduplicates by `requestId` (R21.4), so re-emission
 * is safe even when the server already has the Request.
 *
 * Implements:
 *  - R4.1  — connect to the URL from the user setting `kiroGptBridge.relayUrl`.
 *  - R4.3  — first-connect retries up to 5 times with at least 2 s between
 *            attempts before surfacing a connection error.
 *  - R21.1 — exponential backoff `1 s → 30 s` doubling each failed attempt,
 *            indefinite retries after the first success.
 *  - R21.3 — re-emit every non-terminal Request on reconnect.
 *  - R21.5 — re-registration failure (auth) closes the socket and resumes
 *            the backoff schedule.
 *
 * The module is intentionally VS Code-free: dependencies are limited to
 * `socket.io-client` and the `@kiro-gpt-bridge/shared` types so it can be
 * unit-tested headless.
 */

import { io, type Socket } from 'socket.io-client';
import {
  EV,
  exponentialBackoff,
  type Request,
  type RequestId,
  type ClientId,
  type StreamChunk,
  type ClientHandshake,
  type RequestStatusEvent,
  type AgentStatusEvent,
  type ServerStatusEvent,
  type CancelSignal,
} from '@kiro-gpt-bridge/shared';

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * Construction options for {@link createRelayClient}. All injection points
 * (`now`, `ioFactory`, `sleep`) default to production implementations and
 * are only overridden by unit tests.
 */
export interface ExtensionRelayClientOptions {
  /** Relay URL from the user setting `kiroGptBridge.relayUrl`. R4.1. */
  relayUrl: string;
  /** Shared secret from the user settings; sent in the handshake. R2.1. */
  kiroSecret: string;
  /** Extension semver, used in the handshake. */
  clientVersion: string;
  /** Clock injection. Defaults to {@link Date.now}. */
  now?: () => number;
  /**
   * Socket.IO factory injection. Defaults to `io(url, opts)` from
   * `socket.io-client`. Tests pass a stub that returns a `Socket`-shaped
   * object emitting the lifecycle events.
   */
  ioFactory?: (url: string, opts: object) => unknown;
  /**
   * Async sleep injection. Defaults to a `setTimeout`-backed promise.
   * Tests pass a fake clock helper that resolves immediately.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Per-request bookkeeping kept in {@link ExtensionRelayClient.getInflight}.
 * The state field never reaches a terminal status — once a final
 * {@link StreamChunk} arrives, the record is removed from the map by the
 * stream-chunk handler.
 */
export interface RequestRecord {
  /** The original Request as submitted to {@link ExtensionRelayClient.submit}. */
  request: Request;
  /** Current non-terminal lifecycle position. */
  state: 'submitting' | 'queued' | 'dispatched' | 'streaming' | 'cancelling';
  /** Stream chunks observed so far, in arrival order. */
  receivedChunks: string[];
  /** Epoch ms when the most recent chunk arrived, or the submit time. */
  lastChunkAt: number;
  /** 1-based queue position when `state === 'queued'`. */
  queuePosition?: number;
  /** Number of times this Request has been re-emitted on reconnect. R21.3. */
  reemitCount: number;
}

/**
 * Public surface of the relay client. The KIRO extension drives this
 * object; tests inspect {@link getInflight} for invariants.
 */
export interface ExtensionRelayClient {
  /** Begin connecting. Resolves on first successful connect+registration. */
  start(): Promise<void>;
  /** Stop the client; closes the socket and cancels any pending reconnect. */
  stop(): void;
  /** Whether the underlying socket is currently connected. */
  isConnected(): boolean;
  /** Server-issued client id, populated after the first successful connect. */
  clientId(): ClientId | null;
  /**
   * Submit a new Request. The Request is added to the inflight map and
   * emitted to the relay if connected. On subsequent reconnects it is
   * re-emitted automatically.
   */
  submit(request: Request): void;
  /** Cancel an in-flight request via the `request.cancel` event. */
  cancel(requestId: RequestId): void;
  /** Subscribe to `stream.chunk` events. */
  onStreamChunk(h: (chunk: StreamChunk) => void): void;
  /** Subscribe to `request.status` events. */
  onRequestStatus(h: (e: RequestStatusEvent) => void): void;
  /** Subscribe to `agent.status` broadcasts. */
  onAgentStatus(h: (e: AgentStatusEvent) => void): void;
  /** Subscribe to `server.status` broadcasts. */
  onServerStatus(h: (e: ServerStatusEvent) => void): void;
  /** Subscribe to socket connect/disconnect transitions. */
  onConnectionChange(h: (connected: boolean) => void): void;
  /** Read a snapshot of every non-terminal record. */
  getInflight(): RequestRecord[];
  /**
   * Read the live inflight map. The returned reference is the same
   * `Map` instance the client mutates on every {@link submit},
   * {@link cancel}, and incoming {@link StreamChunk}; callers SHOULD
   * NOT mutate keys but MAY mutate {@link RequestRecord.state} to
   * support the R16.6 watchdog (`createInflightWatchdog` flips
   * `'streaming' → 'cancelling'` to suppress re-firing).
   */
  getInflightMap(): Map<RequestId, RequestRecord>;
}

// ─── Internal constants ────────────────────────────────────────────────────

/**
 * Maximum number of connect attempts during the very first {@link start}
 * call before {@link start} rejects. R4.3.
 */
const MAX_FIRST_RETRIES = 5;

/**
 * Per-attempt connection timeout in milliseconds. R4.3 specifies the
 * 10 s ceiling; we plumb this through `socket.io-client`'s `timeout`
 * option and also use it as the `connect`-event wait window.
 */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Lower bound on the gap between first-connect retries. R4.3 mandates
 * "at least 2 seconds between attempts"; the exponential schedule's
 * first delay would otherwise be 1 s, which violates the requirement.
 */
const FIRST_RETRY_MIN_DELAY_MS = 2_000;

// ─── Implementation ───────────────────────────────────────────────────────

/**
 * Construct an {@link ExtensionRelayClient}. The returned object is
 * single-use: call {@link ExtensionRelayClient.start} once, then either
 * {@link ExtensionRelayClient.stop} or wait for the process to exit.
 *
 * @param opts See {@link ExtensionRelayClientOptions}.
 * @returns A configured but not-yet-connected client.
 */
export function createRelayClient(
  opts: ExtensionRelayClientOptions,
): ExtensionRelayClient {
  const now: () => number = opts.now ?? Date.now;
  const sleep: (ms: number) => Promise<void> =
    opts.sleep ??
    ((ms) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        if (typeof t.unref === 'function') t.unref();
      }));
  const ioFactory: (url: string, opts: object) => unknown =
    opts.ioFactory ?? ((url, o) => io(url, o));

  // ─── State held in closure ──────────────────────────────────────────────

  /** Per-request bookkeeping; key is the wire `requestId`. */
  const inflight = new Map<RequestId, RequestRecord>();
  /** Active socket; `null` while disconnected or before {@link start}. */
  let socket: Socket | null = null;
  /** Most recent server-issued client id, if known. */
  let clientIdValue: ClientId | null = null;
  /** Whether {@link start} has already been called. */
  let started = false;
  /** Whether {@link stop} has been called. */
  let stopped = false;
  /** Pending reconnect timer, cleared on {@link stop}. */
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const streamChunkHandlers: Array<(c: StreamChunk) => void> = [];
  const reqStatusHandlers: Array<(e: RequestStatusEvent) => void> = [];
  const agentStatusHandlers: Array<(e: AgentStatusEvent) => void> = [];
  const serverStatusHandlers: Array<(e: ServerStatusEvent) => void> = [];
  const connectionHandlers: Array<(c: boolean) => void> = [];

  // ─── Wire-event helpers ─────────────────────────────────────────────────

  /**
   * Emit `request.submit` on the live socket. Caller must have already
   * inserted the record into {@link inflight}.
   */
  function emitSubmit(request: Request): void {
    if (socket && socket.connected) {
      socket.emit(EV.REQUEST_SUBMIT, request);
    }
  }

  /** Emit `request.cancel` on the live socket if connected. */
  function emitCancel(requestId: RequestId): void {
    if (socket && socket.connected) {
      const sig: CancelSignal = { protocolVersion: 1, requestId };
      socket.emit(EV.REQUEST_CANCEL, sig);
    }
  }

  /**
   * Re-emit every non-terminal Request after a successful reconnect.
   * The relay deduplicates by `requestId` (R21.4); we increment
   * `reemitCount` so tests can observe how many times a record bounced
   * across socket failures.
   */
  function reemitInflight(): void {
    for (const rec of inflight.values()) {
      rec.reemitCount += 1;
      // R21.3: re-emit regardless of whether we previously saw a
      // `dispatched` or `queued` ack. The relay decides the new state.
      emitSubmit(rec.request);
      // If the user issued a cancel before the disconnect, re-issue
      // it so the relay can resume the cancellation path.
      if (rec.state === 'cancelling') {
        emitCancel(rec.request.requestId);
      }
    }
  }

  /** Notify subscribers that the connection state changed. */
  function notifyConnection(connected: boolean): void {
    for (const h of connectionHandlers) {
      try {
        h(connected);
      } catch {
        // Swallow listener errors; the relay client must not crash on
        // a faulty subscriber.
      }
    }
  }

  /**
   * Apply a `stream.chunk` payload to the inflight record (when present)
   * and forward it to every subscriber. On `isFinal:true` the record is
   * removed so the inflight watchdog stops scanning it.
   */
  function handleStreamChunk(chunk: StreamChunk): void {
    const rec = inflight.get(chunk.requestId);
    if (rec) {
      rec.receivedChunks.push(chunk.text);
      rec.lastChunkAt = now();
      if (
        rec.state === 'submitting' ||
        rec.state === 'queued' ||
        rec.state === 'dispatched'
      ) {
        rec.state = 'streaming';
      }
      if (chunk.isFinal) {
        inflight.delete(chunk.requestId);
      }
    }
    for (const h of streamChunkHandlers) {
      try {
        h(chunk);
      } catch {
        // Swallow listener errors.
      }
    }
  }

  /**
   * Apply a `request.status` event to the inflight record (when present)
   * and forward it to every subscriber. The local state mirrors the
   * relay's view so the status bar / inflight watchdog see the correct
   * state during the streaming window.
   */
  function handleRequestStatus(event: RequestStatusEvent): void {
    const rec = inflight.get(event.requestId);
    if (rec) {
      switch (event.status) {
        case 'received':
        case 'dispatched':
        case 'dispatch_retrying':
        case 'redispatching':
          rec.state = 'dispatched';
          rec.queuePosition = undefined;
          break;
        case 'queued':
        case 'queued_after_dispatch_failure':
          rec.state = 'queued';
          rec.queuePosition = event.queuePosition;
          break;
        case 'streaming':
          rec.state = 'streaming';
          rec.queuePosition = undefined;
          break;
        case 'cancelling':
          rec.state = 'cancelling';
          break;
        case 'cancelled':
          // Terminal; the final stream chunk will remove the record.
          rec.state = 'cancelling';
          break;
      }
    }
    for (const h of reqStatusHandlers) {
      try {
        h(event);
      } catch {
        // Swallow listener errors.
      }
    }
  }

  // ─── Connect lifecycle ──────────────────────────────────────────────────

  /**
   * Open a single socket and resolve when `connect` fires; reject when
   * `connect_error` fires or the per-attempt timeout elapses. The handshake
   * payload travels with the connect packet so a relay middleware
   * rejection (R21.5) surfaces as `connect_error`.
   */
  function connectOnce(): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const handshake: ClientHandshake = {
        kiroSecret: opts.kiroSecret,
        clientVersion: opts.clientVersion,
      };

      const sock = ioFactory(opts.relayUrl, {
        auth: handshake,
        // We manage our own backoff schedule per R4.3 / R21.1.
        reconnection: false,
        timeout: CONNECT_TIMEOUT_MS,
        autoConnect: true,
        transports: ['websocket'],
      }) as Socket;

      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        sock.off('connect', onConnect);
        sock.off('connect_error', onConnectError);
        clearTimeout(timeoutHandle);
        fn();
      };

      const onConnect = (): void => {
        settle(() => resolve(sock));
      };
      const onConnectError = (err: Error): void => {
        settle(() => {
          // R21.5: ensure the socket is fully torn down before backoff.
          try {
            sock.disconnect();
          } catch {
            // Ignore — already closed.
          }
          reject(err);
        });
      };

      const timeoutHandle = setTimeout(() => {
        settle(() => {
          try {
            sock.disconnect();
          } catch {
            // Ignore — already closed.
          }
          reject(
            new Error(
              `relay connect timed out after ${CONNECT_TIMEOUT_MS} ms`,
            ),
          );
        });
      }, CONNECT_TIMEOUT_MS);
      if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();

      sock.once('connect', onConnect);
      sock.once('connect_error', onConnectError);
    });
  }

  /**
   * Wire the live event listeners (stream.chunk, request.status, agent.status,
   * server.status, disconnect) on a freshly-connected socket. Called once
   * per successful connect.
   */
  function attachLiveListeners(sock: Socket): void {
    sock.on(EV.STREAM_CHUNK, (chunk: StreamChunk) => handleStreamChunk(chunk));
    sock.on(EV.REQUEST_STATUS, (event: RequestStatusEvent) =>
      handleRequestStatus(event),
    );
    sock.on(EV.AGENT_STATUS, (event: AgentStatusEvent) => {
      for (const h of agentStatusHandlers) {
        try {
          h(event);
        } catch {
          // Swallow listener errors.
        }
      }
    });
    sock.on(EV.SERVER_STATUS, (event: ServerStatusEvent) => {
      for (const h of serverStatusHandlers) {
        try {
          h(event);
        } catch {
          // Swallow listener errors.
        }
      }
    });
    sock.on('disconnect', () => {
      // Only react if this is still the active socket; a `stop()` race
      // could have already replaced or nulled it.
      if (socket !== sock) return;
      socket = null;
      notifyConnection(false);
      if (!stopped) {
        // R21.1: indefinite reconnect with exponential backoff.
        scheduleReconnectLoop();
      }
    });
  }

  /**
   * First-connect loop per R4.3: up to 5 attempts, each with a 10 s
   * timeout and at least 2 s between attempts. Returns `null` on success
   * or the final `Error` on exhaustion.
   */
  async function runFirstConnect(): Promise<Error | null> {
    let lastError: Error = new Error('relay connect failed');
    for (let attempt = 1; attempt <= MAX_FIRST_RETRIES; attempt += 1) {
      if (stopped) return new Error('relay client stopped');
      try {
        const sock = await connectOnce();
        socket = sock;
        attachLiveListeners(sock);
        notifyConnection(true);
        return null;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === MAX_FIRST_RETRIES) break;
        const baseDelay = exponentialBackoff(attempt, 1000, 30_000);
        const delay = Math.max(FIRST_RETRY_MIN_DELAY_MS, baseDelay);
        await sleep(delay);
      }
    }
    return lastError;
  }

  /**
   * Indefinite reconnect loop per R21.1. After each successful reconnect
   * the inflight map is replayed via {@link reemitInflight} (R21.3). On
   * `connect_error` (including R21.5 re-registration failures) the next
   * delay is `exponentialBackoff(attempt)`.
   */
  function scheduleReconnectLoop(): void {
    let attempt = 1;
    const tick = async (): Promise<void> => {
      while (!stopped) {
        try {
          const sock = await connectOnce();
          socket = sock;
          attachLiveListeners(sock);
          notifyConnection(true);
          // R21.3: re-emit every non-terminal Request after a successful
          // reconnect. The relay deduplicates by requestId (R21.4).
          reemitInflight();
          return;
        } catch {
          if (stopped) return;
          const delay = exponentialBackoff(attempt, 1000, 30_000);
          attempt += 1;
          await sleep(delay);
        }
      }
    };
    // Fire-and-forget; stop() flips `stopped` to break the loop.
    void tick();
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  async function start(): Promise<void> {
    if (started) {
      throw new Error('ExtensionRelayClient.start() called twice');
    }
    started = true;
    const err = await runFirstConnect();
    if (err) {
      stopped = true;
      throw err;
    }
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const sock = socket;
    socket = null;
    if (sock) {
      try {
        sock.removeAllListeners();
        sock.disconnect();
      } catch {
        // Ignore — socket may already be closed.
      }
    }
    notifyConnection(false);
  }

  function isConnected(): boolean {
    return socket !== null && socket.connected === true;
  }

  function clientId(): ClientId | null {
    return clientIdValue;
  }

  function submit(request: Request): void {
    const existing = inflight.get(request.requestId);
    if (!existing) {
      inflight.set(request.requestId, {
        request,
        state: 'submitting',
        receivedChunks: [],
        lastChunkAt: now(),
        reemitCount: 0,
      });
    }
    // Whether or not we're connected, the next reconnect's reemitInflight
    // will re-issue the submit; emitting now lets the relay start work
    // immediately when the socket is live.
    emitSubmit(request);
  }

  function cancel(requestId: RequestId): void {
    const rec = inflight.get(requestId);
    if (rec) rec.state = 'cancelling';
    emitCancel(requestId);
  }

  function onStreamChunk(h: (chunk: StreamChunk) => void): void {
    streamChunkHandlers.push(h);
  }
  function onRequestStatus(h: (e: RequestStatusEvent) => void): void {
    reqStatusHandlers.push(h);
  }
  function onAgentStatus(h: (e: AgentStatusEvent) => void): void {
    agentStatusHandlers.push(h);
  }
  function onServerStatus(h: (e: ServerStatusEvent) => void): void {
    serverStatusHandlers.push(h);
  }
  function onConnectionChange(h: (connected: boolean) => void): void {
    connectionHandlers.push(h);
  }

  function getInflight(): RequestRecord[] {
    return Array.from(inflight.values());
  }

  function getInflightMap(): Map<RequestId, RequestRecord> {
    return inflight;
  }

  return {
    start,
    stop,
    isConnected,
    clientId,
    submit,
    cancel,
    onStreamChunk,
    onRequestStatus,
    onAgentStatus,
    onServerStatus,
    onConnectionChange,
    getInflight,
    getInflightMap,
  };
}
