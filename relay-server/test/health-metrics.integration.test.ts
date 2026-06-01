/**
 * Integration test for /health and /metrics — task 4.6.
 *
 * Boots Express with the route handlers using a stubbed dispatcher.
 * Asserts JSON shape for /health and Prometheus text content for /metrics.
 * Asserts /metrics responds in <1000 ms.
 *
 * Implements R1.7, R24.5.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createHealthHandler, type HealthProvider } from '../src/routes/health.js';
import { createMetrics, createMetricsHandler, type MetricsProvider } from '../src/routes/metrics.js';

let server: Server;
let baseUrl: string;

const startTime = Date.now();

/** Stubbed health provider simulating a dispatcher with 2 agents. */
const healthProvider: HealthProvider = {
  uptimeSeconds: () => (Date.now() - startTime) / 1000,
  registeredAgents: () => 2,
  registeredClients: () => 3,
  queueDepth: () => 5,
  allAgentsLoginRequired: () => false,
};

/** Stubbed metrics provider. */
const metricsProvider: MetricsProvider = {
  queueDepth: () => 5,
  agentsConnected: () => 2,
};

beforeAll(async () => {
  const app = express();
  const metrics = createMetrics();

  app.get('/health', createHealthHandler(healthProvider));
  app.get('/metrics', createMetricsHandler(metrics, metricsProvider));

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('/health endpoint', () => {
  it('returns 200 with correct JSON shape', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('uptimeSeconds');
    expect(body).toHaveProperty('registeredAgents');
    expect(body).toHaveProperty('registeredClients');
    expect(body).toHaveProperty('queueDepth');

    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.registeredAgents).toBe(2);
    expect(body.registeredClients).toBe(3);
    expect(body.queueDepth).toBe(5);
  });

  it('returns "degraded" when all agents are login_required', async () => {
    // Temporarily override
    const original = healthProvider.allAgentsLoginRequired;
    (healthProvider as { allAgentsLoginRequired: () => boolean }).allAgentsLoginRequired = () => true;

    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');

    (healthProvider as { allAgentsLoginRequired: () => boolean }).allAgentsLoginRequired = original;
  });

  it('returns "degraded" when zero agents registered', async () => {
    const original = healthProvider.registeredAgents;
    (healthProvider as { registeredAgents: () => number }).registeredAgents = () => 0;

    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('degraded');

    (healthProvider as { registeredAgents: () => number }).registeredAgents = original;
  });
});

describe('/metrics endpoint', () => {
  it('returns Prometheus text format with expected metrics', async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);

    const contentType = res.headers.get('content-type') ?? '';
    // prom-client uses text/plain or application/openmetrics-text
    expect(contentType).toMatch(/text\/plain|openmetrics/);

    const body = await res.text();
    expect(body).toContain('requests_total');
    expect(body).toContain('requests_failed_total');
    expect(body).toContain('queue_depth');
    expect(body).toContain('agents_connected');
    expect(body).toContain('request_duration_seconds');
    expect(body).toContain('log_failures_total');
  });

  it('responds within 1000 ms', async () => {
    const start = performance.now();
    await fetch(`${baseUrl}/metrics`);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });

  it('reflects current gauge values from provider', async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    const body = await res.text();
    // queue_depth gauge should show 5
    expect(body).toContain('queue_depth 5');
    // agents_connected gauge should show 2
    expect(body).toContain('agents_connected 2');
  });
});
