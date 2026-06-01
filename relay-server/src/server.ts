/**
 * HTTP/HTTPS + Express + Socket.IO server factory for the Relay Server.
 *
 * Mounts the read-only inspection routes (`GET /health`, `GET /metrics`)
 * and constructs the Socket.IO server that the per-role handler modules
 * (`socket/clientHandlers.ts`, `socket/agentHandlers.ts`) attach their
 * middleware and listeners to.
 *
 * Implements:
 *  - R1.1   Listen on the configured `PORT` (binding is performed by the
 *           orchestrator via {@link ServerHandles.httpServer}.listen()).
 *  - R1.3   Socket.IO frames are capped at 100 MB via
 *           `maxHttpBufferSize`. Larger frames are rejected by the
 *           Socket.IO transport before reaching any application handler.
 *  - R1.4   The 100 MB ceiling produces a transport-level rejection that
 *           the structured logger surfaces under the `bind_failed` /
 *           `connection_error` events; payload-too-large at the LOGICAL
 *           layer (R26.6) is enforced in {@link socket/clientHandlers}.
 *  - R1.5   {@link ServerHandles.shutdown} closes the HTTP listener and
 *           the Socket.IO server so no new connections are accepted.
 *  - R1.7   `GET /health` is wired through {@link createHealthHandler}.
 *  - R1.8   Bind failures emit a structured `bind_failed` log line; the
 *           orchestrator (`index.ts`) is responsible for the non-zero
 *           exit because it owns the process lifecycle.
 *  - R2.4   When `config.tls.enabled === true` the underlying server is
 *           an `https.Server` constructed from the cert/key buffers
 *           pre-read by {@link loadConfig}.
 *  - R24.5  `GET /metrics` is wired through {@link createMetricsHandler}.
 *
 * The factory is intentionally I/O-pure: it does NOT call `.listen()`,
 * register signal handlers, or wire any socket events. Those concerns
 * belong to the orchestrator (task 8.4) so this module can be unit-
 * tested without binding a port and so the per-role socket handler
 * modules can attach their own middleware and listeners.
 */

import express, { type Express } from 'express';
import http from 'node:http';
import https from 'node:https';
import { Server as IOServer } from 'socket.io';
import cors from 'cors';
import type { RelayConfig } from './config.js';
import { createHealthHandler, type HealthProvider } from './routes/health.js';
import {
  createMetricsHandler,
  type MetricsProvider,
  type RelayMetrics,
} from './routes/metrics.js';
import { logSafe } from './log/logger.js';

/** Maximum Socket.IO frame size in bytes — 100 MB per R1.3. */
const SOCKET_MAX_HTTP_BUFFER_BYTES = 100 * 1024 * 1024;

/**
 * Bundle of constructed server objects returned by {@link createServer}.
 *
 * The orchestrator drives the lifecycle:
 *   1. Pass `io` to the per-role handler modules so they can attach
 *      middleware and listeners.
 *   2. Call `httpServer.listen(port, callback)` to bind.
 *   3. On SIGTERM/SIGINT, call `shutdown(drainMs)`.
 */
export interface ServerHandles {
  /** The Express application — exposed for tests that hit `/health` / `/metrics`. */
  readonly app: Express;
  /** The underlying HTTP or HTTPS server. The orchestrator calls `.listen()` on it. */
  readonly httpServer: http.Server | https.Server;
  /** The Socket.IO server. Per-role handler modules attach middleware and listeners. */
  readonly io: IOServer;
  /**
   * Stop accepting new connections, then wait up to `drainMs` for the
   * Socket.IO server to settle in-flight frames before resolving.
   *
   * The promise always resolves (never rejects). Subsequent calls are
   * no-ops.
   *
   * Implements R1.5.
   *
   * @param drainMs Soft deadline for the Socket.IO drain. Default 30_000.
   */
  shutdown(drainMs?: number): Promise<void>;
}

/**
 * Build the HTTP/HTTPS server, the Express app with health + metrics
 * routes, and the Socket.IO server.
 *
 * The factory does NOT call `.listen()`. The orchestrator binds the
 * server in `index.ts` so it can react to bind success vs. failure
 * (R1.8) without coupling the inspection-route module to lifecycle
 * concerns.
 *
 * Implements R1.1, R1.3, R1.4, R1.7, R1.8, R2.4, R24.5.
 *
 * @param config Validated runtime configuration produced by {@link loadConfig}.
 * @param healthProvider Live source of `/health` payload values.
 * @param metricsProvider Live source of dispatcher-owned gauge values.
 * @param metrics Pre-constructed Prometheus instruments.
 * @returns Server handles for the orchestrator and per-role handler modules.
 */
export function createServer(
  config: RelayConfig,
  healthProvider: HealthProvider,
  metricsProvider: MetricsProvider,
  metrics: RelayMetrics,
): ServerHandles {
  const app: Express = express();
  // Browser-driven dashboards may scrape /health and /metrics from
  // arbitrary origins; the inspection routes carry no secret state and
  // are safe to expose with `*`.
  app.use(cors({ origin: '*' }));
  app.get('/health', createHealthHandler(healthProvider));
  app.get('/metrics', createMetricsHandler(metrics, metricsProvider));

  // R2.4: when TLS is enabled, hand the pre-read cert/key buffers to
  // `https.createServer`. {@link loadConfig} already validated that the
  // files exist and are readable, so this never throws here.
  const httpServer: http.Server | https.Server = config.tls.enabled
    ? https.createServer({ cert: config.tls.cert, key: config.tls.key }, app)
    : http.createServer(app);

  // R1.3: Socket.IO transport ceiling. Frames larger than this are
  // dropped by the transport before any application handler observes
  // them. Logical 25 MB limits at the message level (R26.6) are
  // enforced inside `socket/clientHandlers.ts`.
  const io: IOServer = new IOServer(httpServer, {
    maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_BYTES,
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  // R1.8: structured-log bind failures. The orchestrator owns the exit
  // code (S2.6 forbids `process.exit(0)` from this module's scope).
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    logSafe('error', 'bind_failed', {
      port: config.port,
      code: err.code ?? null,
      message: err.message,
    });
  });

  /** Idempotency guard for {@link shutdown}. */
  let shutdownStarted = false;

  async function shutdown(drainMs: number = 30_000): Promise<void> {
    if (shutdownStarted) return;
    shutdownStarted = true;

    logSafe('info', 'shutdown_initiated', { drainMs });

    // R1.5: stop accepting new HTTP/Socket.IO connections.
    try {
      httpServer.close();
    } catch (e) {
      logSafe('warn', 'httpServer_close_error', {
        message: e instanceof Error ? e.message : String(e),
      });
    }

    // Race io.close() against the soft deadline. `io.close()` invokes
    // its callback once every connected socket has acknowledged the
    // disconnect; on a stuck socket the timer wins.
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, drainMs));
      timer.unref?.();
      try {
        io.close((err) => {
          clearTimeout(timer);
          if (err !== undefined) {
            logSafe('warn', 'io_close_error', {
              message: err instanceof Error ? err.message : String(err),
            });
          }
          finish();
        });
      } catch (e) {
        clearTimeout(timer);
        logSafe('warn', 'io_close_throw', {
          message: e instanceof Error ? e.message : String(e),
        });
        finish();
      }
    });

    logSafe('info', 'shutdown_complete', {});
  }

  return { app, httpServer, io, shutdown };
}
