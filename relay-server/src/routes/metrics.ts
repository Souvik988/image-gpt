/**
 * Prometheus metrics endpoint for the Relay Server.
 *
 * Implements R24.5 (GET /metrics returns Prometheus text within 1 s) and
 * R24.4 (a `log_failures_total` counter is exposed so the structured logger
 * can record emission failures without aborting request processing).
 *
 * Design notes:
 * - {@link createMetrics} builds a fresh `prom-client` `Registry` per call.
 *   We deliberately avoid the library's global default registry so each
 *   server instance — and each test — gets isolated state.
 * - Counters use the Prometheus convention `_total` suffix.
 * - The histogram uses the `prom-client` default buckets, which span
 *   sub-second to multi-second durations and match R24.5's latency target.
 * - {@link createMetricsHandler} reads the gauge values fresh on every
 *   scrape via the supplied {@link MetricsProvider}; the response therefore
 *   reflects the relay's state at the moment of scrape rather than the
 *   moment a gauge was last set.
 */

import type { Request, Response } from 'express';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Source of live values for gauges that cannot be incremented in place
 * (queue depth and connected-agent count are derived state owned by the
 * dispatcher and agent pool respectively). The handler calls these
 * functions on every scrape so the exposed values are always current.
 *
 * Implements R24.5.
 */
export interface MetricsProvider {
  /** Current `Pending_Queue` depth (R6.x). */
  queueDepth(): number;
  /** Number of currently registered, non-disconnected agents (R3.x). */
  agentsConnected(): number;
}

/**
 * Bundle of registered Prometheus instruments returned by
 * {@link createMetrics}. Holding all instruments together keeps the
 * dispatcher, socket handlers, and logger from each having to know about
 * the registry directly.
 *
 * Implements R24.5, R24.4.
 */
export interface RelayMetrics {
  /** The isolated `prom-client` registry these instruments are registered on. */
  registry: Registry;
  /**
   * `requests_total{type, terminal}` — every Request that reached a
   * terminal state, labelled by Request type ("chat" | "image") and the
   * terminal state ("completed" | "cancelled" | "failed" | "queue_timeout").
   */
  requestsTotal: Counter<'type' | 'terminal'>;
  /**
   * `requests_failed_total{errorCode}` — Request failures broken down by
   * the canonical {@link import('@kiro-gpt-bridge/shared').ErrorCode}.
   */
  requestsFailedTotal: Counter<'errorCode'>;
  /** `queue_depth` — current `Pending_Queue` size, set per scrape. */
  queueDepth: Gauge<string>;
  /** `agents_connected` — count of registered agents, set per scrape. */
  agentsConnected: Gauge<string>;
  /**
   * `request_duration_seconds{type, terminal}` — wall-clock duration from
   * "received" to terminal state. Uses `prom-client` default buckets.
   */
  requestDurationSeconds: Histogram<'type' | 'terminal'>;
  /**
   * `log_failures_total` — incremented by the structured logger whenever
   * a log-emission attempt throws. Implements R24.4.
   */
  logFailuresTotal: Counter<string>;
}

/**
 * Construct the metrics registry and instruments.
 *
 * Each call returns a fresh {@link Registry}; the global default registry
 * from `prom-client` is never touched, which keeps tests isolated and
 * avoids accidental cross-server pollution.
 *
 * Implements R24.5.
 */
export function createMetrics(): RelayMetrics {
  const registry = new Registry();

  const requestsTotal = new Counter({
    name: 'requests_total',
    help: 'Total number of Requests that reached a terminal state, labelled by Request type and terminal state.',
    labelNames: ['type', 'terminal'] as const,
    registers: [registry],
  });

  const requestsFailedTotal = new Counter({
    name: 'requests_failed_total',
    help: 'Total number of Requests that terminated in the failed state, labelled by errorCode.',
    labelNames: ['errorCode'] as const,
    registers: [registry],
  });

  const queueDepth = new Gauge({
    name: 'queue_depth',
    help: 'Current depth of the Pending_Queue. Sampled at scrape time.',
    registers: [registry],
  });

  const agentsConnected = new Gauge({
    name: 'agents_connected',
    help: 'Number of currently registered, non-disconnected agents. Sampled at scrape time.',
    registers: [registry],
  });

  const requestDurationSeconds = new Histogram({
    name: 'request_duration_seconds',
    help: 'Wall-clock duration in seconds from Request received to terminal state, labelled by Request type and terminal state.',
    labelNames: ['type', 'terminal'] as const,
    registers: [registry],
    // No `buckets` override — `prom-client` uses its default buckets which
    // span sub-second to multi-second durations and are appropriate for
    // chat (~0.5–60 s) and image (~5–180 s) Requests.
  });

  const logFailuresTotal = new Counter({
    name: 'log_failures_total',
    help: 'Total number of structured log emission failures (R24.4).',
    registers: [registry],
  });

  return {
    registry,
    requestsTotal,
    requestsFailedTotal,
    queueDepth,
    agentsConnected,
    requestDurationSeconds,
    logFailuresTotal,
  };
}

/**
 * Build the Express GET `/metrics` handler.
 *
 * On each scrape the handler:
 *   1. Pulls fresh values from the {@link MetricsProvider} and writes them
 *      into the `queue_depth` and `agents_connected` gauges, so the
 *      response reflects relay state at the moment of scrape.
 *   2. Sets `Content-Type` to the Prometheus text format
 *      (`text/plain; version=0.0.4; charset=utf-8`) using the registry's
 *      own `contentType` constant so the value never drifts from the
 *      `prom-client` library's choice.
 *   3. Awaits `registry.metrics()` (which returns `Promise<string>`) and
 *      sends the rendered text body.
 *
 * Returns within ≤ 1000 ms in normal operation (R24.5).
 *
 * Implements R24.5. R24.4 is satisfied passively here — the
 * `log_failures_total` counter is built in {@link createMetrics} and the
 * structured logger increments it; this handler simply exposes it.
 */
export function createMetricsHandler(
  metrics: RelayMetrics,
  provider: MetricsProvider,
): (req: Request, res: Response) => Promise<void> {
  return async function metricsHandler(_req: Request, res: Response): Promise<void> {
    metrics.queueDepth.set(provider.queueDepth());
    metrics.agentsConnected.set(provider.agentsConnected());

    res.setHeader('Content-Type', metrics.registry.contentType);
    const body = await metrics.registry.metrics();
    res.send(body);
  };
}
