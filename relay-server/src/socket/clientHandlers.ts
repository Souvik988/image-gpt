/**
 * Socket.IO event handlers for KIRO Extension clients.
 *
 * Mounted by the orchestrator in `index.ts` after {@link createServer}
 * builds the Socket.IO server and before `httpServer.listen()` is
 * called. The module owns:
 *
 *  - The handshake-auth middleware (R2.1, R2.2, R2.3) keyed by the
 *    KIRO_SECRET, with an IP-keyed brute-force tracker (R2.6) and a
 *    50-concurrent-client capacity gate (R4.6, R4.7).
 *  - The post-connect listeners for `request.submit` (R5.1 ingress)
 *    and `request.cancel` (R20.3 ingress).
 *  - Disconnect cleanup that asks the dispatcher to cancel queued
 *    requests of the disconnecting client (R4.5, R6.8).
 *  - Wire-schema validation (R26.5, R26.6) on every inbound payload.
 *  - Re-emit dedup (R21.3, R21.4) — the dispatcher itself enforces the
 *    `requestTable.add` uniqueness invariant; this handler trusts the
 *    dispatcher to silently drop duplicates.
 *
 * This module is the SOLE source of `clientId` issuance: a fresh
 * 16–64-char id is minted on every successful authenticated connection
 * (R4.4) and threaded into every subsequent `Request` so the dispatcher
 * can route stream chunks back to the originating socket.
 *
 * The handler is wired through the {@link ClientRegistry} interface so
 * the orchestrator can keep the canonical `clientId → Socket` lookup
 * map alongside the agent registry without coupling this module to a
 * specific data structure.
 */

import { randomUUID } from 'node:crypto';
import type { Server as IOServer, Socket } from 'socket.io';
import {
  EV,
  validateRequest,
  validateCancelSignal,
  validateClientHandshake,
  type Request,
  type ClientId,
  type ErrorCode,
  type StreamChunk,
} from '@kiro-gpt-bridge/shared';
import { compareSecrets } from '../auth/secret.js';
import type { RateLimiter } from '../auth/rateLimiter.js';
import type { Dispatcher } from '../dispatch/dispatcher.js';
import type { RequestTable } from '../tracking/requestTable.js';
import { logSafe } from '../log/logger.js';

/** Maximum logical message size in bytes — R26.6 (25 MB ceiling). */
const MESSAGE_SIZE_LIMIT_BYTES = 25 * 1024 * 1024;

/** Maximum number of concurrently-registered clients — R4.7. */
const CLIENT_CAPACITY = 50;

/**
 * Reasons emitted as part of `connect_error` payloads. The strings are
 * load-bearing: the extension's relay client matches them with the
 * regex `/auth|Authentication|unauthorized/i` to drive its own backoff
 * loop (R11.6 wording). Keep them in this taxonomy.
 */
const REJECT_REASON = {
  /** R2.3 — bad/missing/expired secret. */
  AUTH_FAILED: 'AUTH_FAILED',
  /** R2.6 — IP locked out for 300 s after 5 failures in 60 s. */
  AUTH_RATE_LIMITED: 'AUTH_FAILED: rate_limited',
  /** R4.7 — > 50 concurrent registered clients. */
  CAPACITY_EXCEEDED: 'CAPACITY_EXCEEDED',
} as const;

/**
 * Adapter the orchestrator implements so this module can register/
 * deregister clients in whatever data structures the orchestrator
 * keeps for the dispatcher transport.
 *
 * Implementations must be cheap: every method is called on the socket
 * I/O hot path.
 */
export interface ClientRegistry {
  /**
   * Record a successful client authentication. Called once per
   * `connection` event after the auth middleware has cleared.
   */
  registerClient(socket: Socket, clientId: ClientId): void;
  /** Drop the registry entry. Called once per `disconnect`. */
  unregisterClient(clientId: ClientId): void;
  /** Current count of registered clients (R4.6, R4.7 capacity check). */
  getRegisteredClientCount(): number;
}

/**
 * Construction options for {@link attachClientHandlers}.
 */
export interface ClientHandlersDeps {
  /** Live Socket.IO server, built by {@link createServer}. */
  io: IOServer;
  /** Validated KIRO_SECRET from {@link RelayConfig.kiroSecret}. */
  kiroSecret: string;
  /** IP brute-force tracker (R2.6). */
  rateLimiter: RateLimiter;
  /** Dispatcher whose `submit`/`cancel`/`onClientDisconnected` methods we wire into. */
  dispatcher: Dispatcher;
  /** Request table used to deduplicate re-emitted submits (R21.3, R21.4). */
  requestTable: RequestTable;
  /** Adapter back to the orchestrator's per-client bookkeeping. */
  registry: ClientRegistry;
}

/**
 * Mint a fresh 16–64 char client id (R4.4). UUID v4 with hyphens is 36
 * chars, comfortably inside the bound. We strip nothing because the
 * downstream extension treats the value as opaque.
 */
function mintClientId(): ClientId {
  return randomUUID();
}

/**
 * Attach the auth middleware and per-socket listeners to the supplied
 * Socket.IO server. The function returns no handle; subscriptions are
 * detached automatically when the server is closed.
 *
 * Implements R2.1, R2.2, R2.3, R2.6, R4.4, R4.5, R4.6, R4.7, R5.1,
 * R6.8, R20.3, R21.3, R21.4, R26.5, R26.6.
 *
 * @param deps See {@link ClientHandlersDeps}.
 */
export function attachClientHandlers(deps: ClientHandlersDeps): void {
  const { io, kiroSecret, rateLimiter, dispatcher, requestTable, registry } = deps;

  // ─── Auth middleware (R2.1, R2.2, R2.3, R2.6, R4.6, R4.7) ────────────
  // The middleware ALSO discriminates KIRO clients from browser agents
  // by inspecting the handshake `auth` payload: agent handshakes carry
  // an `agentSecret` field, client handshakes carry `kiroSecret`. We
  // skip clients with an `agentSecret` so the agent-side middleware
  // (attached separately by `attachAgentHandlers`) can validate them.
  //
  // Rate-limiter contract (see `auth/rateLimiter.ts`):
  //   - When the IP is currently locked, `tryConnect(ip, anything)`
  //     returns `{ allowed: false }` WITHOUT touching the failure
  //     window — so a locked-out attacker can never extend their own
  //     lockout, and we never have to "consult-then-decide".
  //   - On a not-locked IP, `tryConnect(ip, true)` clears the failure
  //     window; `tryConnect(ip, false)` appends a failure timestamp
  //     and may itself trigger a fresh 300 s lockout.
  // Therefore the natural pattern is: schema-check → secret-compare →
  // `tryConnect(ip, matches)` once at the end.
  io.use((socket, next) => {
    const ip: string = socket.handshake.address ?? 'unknown';
    const auth = socket.handshake.auth as Record<string, unknown> | undefined;

    // Skip agent connections — handled by `attachAgentHandlers`.
    if (auth !== undefined && typeof auth.agentSecret === 'string') {
      next();
      return;
    }

    // Schema-validate the handshake first. A malformed handshake is
    // treated as a failed attempt (it is indistinguishable from a
    // probe) so it counts toward the brute-force window.
    const handshake = validateClientHandshake(auth);
    if (!handshake.ok) {
      const result = rateLimiter.tryConnect(ip, false);
      logSafe('warn', 'auth_rejected', {
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

    // Constant-time secret comparison. Done before consulting the
    // rate-limiter so the limiter sees a single, accurate verdict per
    // attempt — exactly what the R2.6 reference model is computing.
    const matches = compareSecrets(handshake.value.kiroSecret, kiroSecret);
    const result = rateLimiter.tryConnect(ip, matches);
    if (!result.allowed) {
      // Either the IP is currently locked (matches irrelevant) or
      // this very attempt pushed the failure window to the threshold.
      logSafe('warn', 'auth_rejected', {
        ip,
        reason: matches ? 'rate_limited' : 'bad_secret_or_locked',
        lockedUntil: result.lockedUntil ?? null,
      });
      next(new Error(REJECT_REASON.AUTH_RATE_LIMITED));
      return;
    }
    if (!matches) {
      logSafe('warn', 'auth_rejected', { ip, reason: 'bad_secret' });
      next(new Error(REJECT_REASON.AUTH_FAILED));
      return;
    }

    // R4.6, R4.7: cap concurrent registered clients at 50.
    if (registry.getRegisteredClientCount() >= CLIENT_CAPACITY) {
      logSafe('warn', 'capacity_exceeded', { ip });
      next(new Error(REJECT_REASON.CAPACITY_EXCEEDED));
      return;
    }

    next();
  });

  // ─── Connection handler ──────────────────────────────────────────────
  io.on('connection', (socket) => {
    const auth = socket.handshake.auth as Record<string, unknown> | undefined;
    // Skip agents — they are handled in `attachAgentHandlers` and ALSO
    // pass through this connection event because Socket.IO does not
    // give us per-namespace `connection` events for the default
    // namespace. The discriminator mirrors the auth-middleware's.
    if (auth !== undefined && typeof auth.agentSecret === 'string') {
      return;
    }

    const clientId: ClientId = mintClientId();
    registry.registerClient(socket, clientId);
    logSafe('info', 'client_connected', {
      clientId,
      ip: socket.handshake.address ?? 'unknown',
    });

    // R20.3 — request.cancel: validate, forward to dispatcher.
    socket.on(EV.REQUEST_CANCEL, (raw: unknown) => {
      const result = validateCancelSignal(raw);
      if (!result.ok) {
        logSafe('warn', 'cancel_invalid', {
          clientId,
          firstFailingField: result.firstFailingField,
          rule: result.rule,
        });
        return;
      }
      dispatcher.cancel(result.value.requestId, clientId);
    });

    // R5.1 — request.submit: validate (R26.5), size-check (R26.6),
    // dedup (R21.3, R21.4), forward to dispatcher.
    socket.on(EV.REQUEST_SUBMIT, (raw: unknown) => {
      // R26.6 — logical message size cap. Socket.IO already rejected
      // anything > 100 MB (R1.3) at the transport layer; this guard
      // catches the 25 MB logical ceiling for the JSON-serializable
      // tree.
      let serializedSize = 0;
      try {
        // Cheap size estimate via JSON length. The exact byte count
        // depends on socket.io's encoder, but the JSON length is a
        // tight upper bound for the sizeable carriers (base64 strings,
        // codeContext file content) we care about.
        serializedSize = JSON.stringify(raw).length;
      } catch {
        // A circular structure here is by definition not a valid
        // Request; let the schema validator below produce a precise
        // SCHEMA_INVALID error instead of inventing a custom code.
        serializedSize = 0;
      }
      if (serializedSize > MESSAGE_SIZE_LIMIT_BYTES) {
        emitSchemaInvalid(
          socket,
          extractRequestId(raw),
          'MESSAGE_TOO_LARGE',
          `serialized size ${serializedSize} > ${MESSAGE_SIZE_LIMIT_BYTES}`,
        );
        return;
      }

      // R26.5 — schema validation.
      const result = validateRequest(raw);
      if (!result.ok) {
        emitSchemaInvalid(
          socket,
          extractRequestId(raw),
          'SCHEMA_INVALID',
          `${result.firstFailingField}: ${result.rule}`,
        );
        return;
      }

      // R4.4 — clientId is server-issued. Override whatever the client
      // sent (the wire schema accepts any non-empty string here; the
      // relay is the source of truth).
      const enriched: Request = { ...result.value, clientId };

      // R21.3, R21.4 — dedup re-emitted submits. The dispatcher's
      // `submit` is itself idempotent on duplicate ids (the request
      // table throws TypeError on re-add and the dispatcher catches),
      // but checking up-front keeps the audit log clean.
      if (requestTable.get(enriched.requestId) !== undefined) {
        logSafe('info', 'submit_dedup', {
          clientId,
          requestId: enriched.requestId,
        });
        return;
      }

      dispatcher.submit(enriched);
    });

    socket.on('disconnect', (reason: string) => {
      logSafe('info', 'client_disconnected', { clientId, reason });
      registry.unregisterClient(clientId);
      // R4.5, R6.8 — cancel queued + in-flight requests of this client.
      try {
        dispatcher.onClientDisconnected(clientId);
      } catch (e) {
        logSafe('warn', 'client_disconnect_handler_error', {
          clientId,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    });
  });
}

/**
 * Send a final-failed {@link StreamChunk} to a single socket carrying
 * the supplied {@link ErrorCode}. Used on schema-invalid / oversize
 * inbound payloads (R26.5, R26.6) so the client always sees a terminal
 * frame instead of silently dropping the request.
 */
function emitSchemaInvalid(
  socket: Socket,
  requestId: string,
  errorCode: ErrorCode,
  message: string,
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
  try {
    socket.emit(EV.STREAM_CHUNK, chunk);
  } catch {
    // Socket may already be closing; nothing to do.
  }
}

/**
 * Best-effort extraction of `requestId` from a malformed payload so the
 * SCHEMA_INVALID stream chunk we emit can be correlated client-side.
 * Returns the literal string `'unknown'` when the input does not carry
 * a string `requestId` field.
 */
function extractRequestId(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) return 'unknown';
  const candidate = (raw as { requestId?: unknown }).requestId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : 'unknown';
}
