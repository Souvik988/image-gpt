/**
 * Socket.IO handshake authentication middleware.
 *
 * Decoupled, well-scoped helper that installs an `io.use(...)` middleware
 * onto a Socket.IO server which:
 *
 *   1. Reads `socket.handshake.auth.role` and accepts only the literal
 *      values `'client'` or `'agent'`. Any other value rejects the
 *      connection with `AUTH_FAILED` (R2.3).
 *   2. Reads `socket.handshake.auth.protocolVersion` and rejects unless it
 *      equals the configured wire-protocol version (default `1`). This
 *      catches forward-incompatible clients before any business logic
 *      runs (R26.1, R26.5).
 *   3. Reads `socket.handshake.auth.kiroSecret` and compares it against
 *      the configured `secret` using the constant-time comparator in
 *      {@link compareSecrets} (R2.1, R2.2, R2.3).
 *   4. On success, attaches `socket.data = { role }` so downstream
 *      listeners can branch on the verified role without re-parsing the
 *      handshake.
 *   5. On any failure, calls `next(new Error('AUTH_FAILED'))` and emits
 *      a structured `auth_rejected` log line carrying the originating
 *      IP address and an ISO 8601 UTC timestamp (R2.3).
 *
 * Implements:
 *  - R2.1, R2.2, R2.3 — handshake auth required within 5 s of socket
 *    establishment; missing/non-matching/late attempts are rejected
 *    with a Socket.IO authentication error and structured-logged.
 *  - R20.7 — `AUTH_FAILED` rejections fail FAST so subsequent
 *    cancel-delivery work is not blocked behind probe traffic.
 *  - R26.1 — `protocolVersion` is locked to the literal `1` for every
 *    cross-process payload at the wire boundary; mismatched versions
 *    are rejected before any payload reaches the application layer.
 *
 * Validates P11 (rate-limit fairness depends on early reject): by
 * running protocol-version + role + secret checks in `io.use(...)`
 * BEFORE the per-role connection handlers are invoked, all rejected
 * attempts terminate at the auth boundary in O(1) work — leaving the
 * downstream rate-limiter free to bookkeep only attempts that actually
 * exercised secret comparison.
 *
 * Design notes:
 *  - This module is intentionally decoupled from
 *    {@link socket/clientHandlers} and {@link socket/agentHandlers}: it
 *    owns ONLY the protocol-version + role + secret + role-tag concerns
 *    so it can be unit-tested without booting the full relay. Tasks 8.1
 *    and 8.4 wire it into `server.ts` / `index.ts`; this file does not
 *    perform that wiring itself.
 *  - The IP-keyed brute-force tracker (R2.6) and the 50-concurrent-
 *    client capacity gate (R4.6, R4.7) live in
 *    {@link socket/clientHandlers}. This middleware deliberately does
 *    not duplicate them so a future single-source orchestrator can
 *    compose the layers in one place.
 *
 * @module relay-server/auth/handshake
 */

import type { Server as IOServer, Socket } from 'socket.io';
import { compareSecrets } from './secret.js';
import { logSafe } from '../log/logger.js';

/** Verified role of an authenticated socket. R20.7. */
export type HandshakeRole = 'client' | 'agent';

/**
 * Shape stamped onto `socket.data` after the middleware accepts the
 * handshake. Downstream listeners read `socket.data.role` to discriminate
 * between KIRO clients and Browser Agents without re-parsing the
 * handshake payload.
 */
export interface HandshakeSocketData {
  /** Verified role of the connected socket. */
  role: HandshakeRole;
}

/**
 * Construction options for {@link installHandshakeAuth}.
 *
 * Implements the minimum surface needed to enforce R2.1, R2.2, R2.3 and
 * R26.1 at the wire boundary. The IP brute-force tracker (R2.6) and
 * client-capacity gate (R4.7) are deliberately NOT part of this options
 * shape — they belong to the per-role handler modules.
 */
export interface HandshakeAuthDeps {
  /**
   * The configured shared secret to compare against
   * `socket.handshake.auth.kiroSecret`. Loaded from environment per
   * {@link RelayConfig.kiroSecret} (R2.5).
   */
  readonly secret: string;
  /**
   * Wire-protocol version required from
   * `socket.handshake.auth.protocolVersion`. Mismatched values are
   * rejected with `AUTH_FAILED` (R26.1). Defaults to `1` to match the
   * literal locked into every cross-process payload schema.
   */
  readonly protocolVersion?: 1;
}

/**
 * The single rejection-error message used by this middleware. The string
 * is load-bearing: the extension's relay client and the browser agent's
 * relay client both match `/auth|Authentication|unauthorized/i` against
 * `connect_error` reasons to drive their own backoff loops (R11.6, R21.5
 * wording). Keep it spelled exactly `'AUTH_FAILED'`.
 */
const AUTH_FAILED_MESSAGE = 'AUTH_FAILED';

/**
 * Default wire-protocol version. The literal `1` is locked into every
 * cross-process payload schema in `@kiro-gpt-bridge/shared`; bumping
 * this constant is therefore a deliberate breaking change that requires
 * updating every payload's `protocolVersion: z.literal(...)` in lockstep.
 */
const DEFAULT_PROTOCOL_VERSION: 1 = 1;

/**
 * Narrow `unknown` to a {@link HandshakeRole}. Returns `null` for
 * anything that is not the literal string `'client'` or `'agent'`.
 */
function parseRole(value: unknown): HandshakeRole | null {
  if (value === 'client' || value === 'agent') return value;
  return null;
}

/**
 * Best-effort extraction of the originating IP for structured logging.
 * Falls back to the literal `'unknown'` so log lines always carry a
 * non-empty `ip` field (R2.3).
 */
function ipOf(socket: Socket): string {
  return socket.handshake.address ?? 'unknown';
}

/**
 * Install the handshake-auth middleware onto `io`.
 *
 * The middleware runs first in the Socket.IO `io.use(...)` chain (or
 * earliest among auth-related middlewares mounted by the orchestrator)
 * so unauthenticated probes terminate before any per-role connection
 * handler is invoked. This is what P11 ("rate-limit fairness depends on
 * early reject") relies on: every rejected attempt is observable in
 * O(1) work at the auth boundary and never reaches the dispatcher,
 * pending-queue, or per-role bookkeeping.
 *
 * The function returns no handle; the middleware subscription is
 * detached automatically when `io` is closed.
 *
 * Implements R2.1, R2.2, R2.3, R20.7, R26.1.
 *
 * @param io   Live Socket.IO server (typically built by `createServer`).
 * @param deps See {@link HandshakeAuthDeps}.
 */
export function installHandshakeAuth(
  io: IOServer,
  deps: HandshakeAuthDeps,
): void {
  const expectedProtocolVersion: 1 = deps.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;

  io.use((socket, next) => {
    const ip = ipOf(socket);
    const auth = socket.handshake.auth as Record<string, unknown> | undefined;

    // A missing or non-object auth payload is by definition a failed
    // attempt — the contract requires every connector to send the role,
    // protocolVersion, and secret tuple within the handshake.
    if (auth === undefined || auth === null) {
      logSafe('warn', 'auth_rejected', {
        ip,
        reason: 'missing_auth_payload',
        timestamp: new Date().toISOString(),
      });
      next(new Error(AUTH_FAILED_MESSAGE));
      return;
    }

    // R26.1 — protocolVersion is locked to a single literal at the wire
    // boundary. A mismatched version is rejected with AUTH_FAILED so
    // forward-incompatible clients cannot leak a partial handshake.
    if (auth.protocolVersion !== expectedProtocolVersion) {
      logSafe('warn', 'auth_rejected', {
        ip,
        reason: 'protocol_version_mismatch',
        expected: expectedProtocolVersion,
        // We log the raw type rather than the value to avoid echoing
        // attacker-controlled bytes back into operator logs.
        receivedType: typeof auth.protocolVersion,
        timestamp: new Date().toISOString(),
      });
      next(new Error(AUTH_FAILED_MESSAGE));
      return;
    }

    // R20.7 — role is the discriminator that downstream listeners use
    // to apply per-role policy. Any value other than 'client'/'agent'
    // fails AUTH_FAILED before secret comparison so probes that omit
    // the role can never trigger a secret-compare side channel.
    const role = parseRole(auth.role);
    if (role === null) {
      logSafe('warn', 'auth_rejected', {
        ip,
        reason: 'invalid_role',
        timestamp: new Date().toISOString(),
      });
      next(new Error(AUTH_FAILED_MESSAGE));
      return;
    }

    // R2.1, R2.2, R2.3 — the kiroSecret field carries the shared
    // secret. We require a non-empty string before delegating to
    // `compareSecrets` so the constant-time comparator never sees a
    // `Buffer.from(undefined)` throw path. The presented length is NOT
    // logged (it is attacker-controlled state from a failed attempt).
    const presented = auth.kiroSecret;
    if (typeof presented !== 'string' || presented.length === 0) {
      logSafe('warn', 'auth_rejected', {
        ip,
        reason: 'missing_secret',
        role,
        timestamp: new Date().toISOString(),
      });
      next(new Error(AUTH_FAILED_MESSAGE));
      return;
    }

    if (!compareSecrets(presented, deps.secret)) {
      logSafe('warn', 'auth_rejected', {
        ip,
        reason: 'bad_secret',
        role,
        timestamp: new Date().toISOString(),
      });
      next(new Error(AUTH_FAILED_MESSAGE));
      return;
    }

    // Stamp the verified role onto `socket.data` for downstream
    // listeners. Using `Object.assign` instead of a wholesale
    // assignment preserves any role-orthogonal fields the orchestrator
    // may have already populated (e.g. tracing metadata) without
    // forcing a generic `Server<…, SocketData>` type bound on every
    // caller.
    const data: HandshakeSocketData = { role };
    Object.assign(socket.data, data);

    logSafe('info', 'auth_accepted', {
      ip,
      role,
      timestamp: new Date().toISOString(),
    });
    next();
  });
}
