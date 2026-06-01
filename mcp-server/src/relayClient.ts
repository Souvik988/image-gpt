/**
 * MCP Server ↔ Relay Server Socket.IO client.
 *
 * Thin wrapper around `socket.io-client` that mirrors the shape of the
 * KIRO Extension's relay client but trades the inflight map for a single
 * `submitAndAwait` primitive: the MCP server submits exactly one image
 * Request per tool call and awaits the final {@link StreamChunk} (the
 * one carrying `isFinal: true`).
 *
 * Implements:
 *  - R31.1 — separate Node process speaking to the relay as a KIRO_Client.
 *  - R31.2 — handshake `{ kiroSecret: process.env.KIRO_GPT_MCP_SECRET,
 *            clientVersion }` on the live connection; reconnect uses
 *            {@link exponentialBackoff} from `@kiro-gpt-bridge/shared`.
 *  - R31.7 — when the relay is unreachable, tool calls surface a
 *            structured `RELAY_UNREACHABLE` error rather than crashing
 *            the MCP stdio loop. {@link McpRelayClient.isConnected} lets
 *            tool handlers short-circuit before submitting.
 *
 * The module is intentionally MCP-SDK-free: dependencies are limited to
 * `socket.io-client` and `@kiro-gpt-bridge/shared` types so it can be
 * unit-tested without booting an actual stdio server.
 */

import { io, type Socket } from 'socket.io-client';
import {
  EV,
  exponentialBackoff,
  type ClientHandshake,
  type Request,
  type RequestId,
  type StreamChunk,
} from '@kiro-gpt-bridge/shared';

// ─── Public types ──────────────────────────────────────────────────────────

/** Construction options for {@link createMcpRelayClient}. */
export interface McpRelayClientOptions {
  /** Relay URL, e.g. `ws://localhost:3001`. */
  relayUrl: string;
  /** Shared KIRO_Secret read from `KIRO_GPT_MCP_SECRET`. R31.2. */
  kiroSecret: string;
  /** MCP-server semver, sent in the handshake. R31.2. */
  clientVersion: string;
  /** Clock injection. Defaults to {@link Date.now}. */
  now?: () => number;
  /**
   * Socket.IO factory injection. Defaults to `io(url, opts)` from
   * `socket.io-client`. Tests pass a stub.
   */
  ioFactory?: (url: string, opts: object) => unknown;
  /**
   * Async sleep injection. Defaults to a `setTimeout`-backed promise.
   * Tests pass a fake clock helper.
   */
  sleep?: (ms: number) => Promise<void>;
}

/** Public surface of the MCP relay client. */
export interface McpRelayClient {
  /**
   * Open the socket and resolve once the first connection succeeds.
   * Rejects only when the very first connect attempt fails after the
   * built-in retry budget (5 attempts) so the caller can choose to keep
   * the MCP server running and surface `RELAY_UNREACHABLE` from each
   * tool call.
   */
  connect(): Promise<void>;
  /** Close the socket and stop reconnecting. Idempotent. */
  disconnect(): void;
  /** Whether the underlying socket is currently connected. */
  isConnected(): boolean;
  /**
   * Submit a single Request and resolve with the final {@link StreamChunk}
   * (the one with `isFinal: true`). The relay deduplicates by
   * `requestId`, so the caller is responsible for assigning a fresh UUID
   * per call.
   *
   * Rejects with:
   *   - `Error('mcp_relay_disconnected')` if the socket disconnects
   *      mid-flight before the final chunk arrives.
   *   - `Error('mcp_relay_timeout')` if no final chunk arrives within
   *      `timeoutMs` (default 420 000 ms — chosen to comfortably cover
   *      the 360 s IMAGE_TIMEOUT plus relay/agent dispatch overhead).
   *
   * On any rejection, the per-request listener is removed so the client
   * stays clean for subsequent calls.
   */
  submitAndAwait(request: Request, timeoutMs?: number): Promise<StreamChunk>;
}

// ─── Internal constants ────────────────────────────────────────────────────

/** Maximum first-connect retries before {@link McpRelayClient.connect} rejects. */
const MAX_FIRST_RETRIES = 5;

/** Per-attempt connect timeout in milliseconds. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Default per-call timeout for {@link McpRelayClient.submitAndAwait}.
 * Must stay above the browser-agent image driver's own deadline
 * (`DEFAULT_TIMEOUT_MS`, currently 600 s) so the agent always fires a
 * clean `IMAGE_TIMEOUT` final chunk before this outer timeout trips a
 * generic `mcp_relay_timeout`. 660 s gives 60 s headroom above the
 * 600 s image deadline for queueing, dispatch, and chunk transit. The
 * caller may override via the second argument.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 660_000;

// ─── Implementation ───────────────────────────────────────────────────────

/**
 * Build an {@link McpRelayClient}. The returned object is single-use: call
 * {@link McpRelayClient.connect} once, then either
 * {@link McpRelayClient.disconnect} or wait for the process to exit.
 */
export function createMcpRelayClient(
  opts: McpRelayClientOptions,
): McpRelayClient {
  const sleep: (ms: number) => Promise<void> =
    opts.sleep ??
    ((ms): Promise<void> =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        if (typeof t.unref === 'function') t.unref();
      }));
  const ioFactory: (url: string, opts: object) => unknown =
    opts.ioFactory ?? ((url, o): unknown => io(url, o));

  // ─── State held in closure ──────────────────────────────────────────────

  /** Active socket; `null` while disconnected or before connect. */
  let socket: Socket | null = null;
  /** Whether {@link disconnect} has been called. */
  let stopped = false;
  /** Whether {@link connect} has already been awaited. */
  let connected = false;

  /**
   * Per-request bookkeeping for in-flight {@link submitAndAwait} calls.
   * Keys are `requestId`. Each entry resolves/rejects exactly once, then
   * is removed. The map exists so a single shared `stream.chunk` listener
   * can route final chunks to the right pending promise without
   * registering N listeners on the socket.
   */
  const pending = new Map<
    RequestId,
    {
      resolve: (chunk: StreamChunk) => void;
      reject: (error: Error) => void;
      timeoutHandle: ReturnType<typeof setTimeout>;
    }
  >();

  // ─── Connect lifecycle ──────────────────────────────────────────────────

  /**
   * Open a single socket and resolve when `connect` fires; reject when
   * `connect_error` fires or the per-attempt timeout elapses. The
   * handshake travels with the connect packet so a relay middleware
   * rejection surfaces as `connect_error`.
   */
  function connectOnce(): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const handshake: ClientHandshake = {
        kiroSecret: opts.kiroSecret,
        clientVersion: opts.clientVersion,
      };

      const sock = ioFactory(opts.relayUrl, {
        auth: handshake,
        // We manage our own backoff schedule per R21.1.
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
              `mcp relay connect timed out after ${CONNECT_TIMEOUT_MS} ms`,
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
   * Wire the live event listeners on a freshly-connected socket. Called
   * once per successful connect. The single shared `stream.chunk`
   * listener routes final chunks into the {@link pending} map.
   */
  function attachLiveListeners(sock: Socket): void {
    sock.on(EV.STREAM_CHUNK, (chunk: StreamChunk) => {
      // Only final chunks resolve the pending promise; intermediate
      // chunks are ignored by the MCP server because tool callers only
      // care about the saved file path.
      if (!chunk.isFinal) return;
      const entry = pending.get(chunk.requestId);
      if (entry === undefined) return;
      pending.delete(chunk.requestId);
      clearTimeout(entry.timeoutHandle);
      entry.resolve(chunk);
    });

    sock.on('disconnect', () => {
      // Only react if this is still the active socket.
      if (socket !== sock) return;
      socket = null;
      // Reject every in-flight request so callers see the failure.
      const error = new Error('mcp_relay_disconnected');
      for (const [, entry] of pending) {
        clearTimeout(entry.timeoutHandle);
        entry.reject(error);
      }
      pending.clear();
      // Schedule a background reconnect if the user did not stop us.
      if (!stopped) {
        scheduleReconnectLoop();
      }
    });
  }

  /**
   * First-connect loop: up to 5 attempts, each with a 10 s timeout, with
   * exponential backoff between attempts. Returns `null` on success or
   * the final `Error` on exhaustion.
   */
  async function runFirstConnect(): Promise<Error | null> {
    let lastError: Error = new Error('mcp relay connect failed');
    for (let attempt = 1; attempt <= MAX_FIRST_RETRIES; attempt += 1) {
      if (stopped) return new Error('mcp relay client stopped');
      try {
        const sock = await connectOnce();
        socket = sock;
        attachLiveListeners(sock);
        return null;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === MAX_FIRST_RETRIES) break;
        const delay = exponentialBackoff(attempt, 1000, 30_000);
        await sleep(delay);
      }
    }
    return lastError;
  }

  /**
   * Indefinite reconnect loop after the first successful connect. Uses
   * {@link exponentialBackoff} per R21.1 / R31.2.
   */
  function scheduleReconnectLoop(): void {
    let attempt = 1;
    const tick = async (): Promise<void> => {
      while (!stopped) {
        try {
          const sock = await connectOnce();
          socket = sock;
          attachLiveListeners(sock);
          return;
        } catch {
          if (stopped) return;
          const delay = exponentialBackoff(attempt, 1000, 30_000);
          attempt += 1;
          await sleep(delay);
        }
      }
    };
    void tick();
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  async function connect(): Promise<void> {
    if (connected) {
      throw new Error('McpRelayClient.connect() called twice');
    }
    connected = true;
    const err = await runFirstConnect();
    if (err) {
      // We failed every retry. Mark stopped so callers can still detect
      // `isConnected() === false` and produce RELAY_UNREACHABLE.
      stopped = true;
      throw err;
    }
  }

  function disconnect(): void {
    if (stopped) return;
    stopped = true;
    const sock = socket;
    socket = null;
    if (sock) {
      try {
        sock.removeAllListeners();
        sock.disconnect();
      } catch {
        // Ignore — already closed.
      }
    }
    // Reject every in-flight request so awaiters do not hang forever.
    const error = new Error('mcp_relay_disconnected');
    for (const [, entry] of pending) {
      clearTimeout(entry.timeoutHandle);
      entry.reject(error);
    }
    pending.clear();
  }

  function isConnected(): boolean {
    return socket !== null && socket.connected === true;
  }

  function submitAndAwait(
    request: Request,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<StreamChunk> {
    return new Promise<StreamChunk>((resolve, reject) => {
      if (socket === null || socket.connected !== true) {
        reject(new Error('mcp_relay_disconnected'));
        return;
      }
      // Defensive: refuse to clobber an existing entry. In normal use
      // the caller always passes a fresh requestId (UUID v4).
      if (pending.has(request.requestId)) {
        reject(
          new Error(
            `mcp_relay_duplicate_request: ${request.requestId} already in-flight`,
          ),
        );
        return;
      }

      const timeoutHandle = setTimeout(() => {
        const entry = pending.get(request.requestId);
        if (entry === undefined) return;
        pending.delete(request.requestId);
        entry.reject(new Error('mcp_relay_timeout'));
      }, timeoutMs);
      if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();

      pending.set(request.requestId, { resolve, reject, timeoutHandle });

      try {
        socket.emit(EV.REQUEST_SUBMIT, request);
      } catch (err) {
        // Synchronous emit failure — clean up before surfacing.
        pending.delete(request.requestId);
        clearTimeout(timeoutHandle);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  return { connect, disconnect, isConnected, submitAndAwait };
}
