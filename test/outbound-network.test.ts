/**
 * Outbound-network boundary test — task 21.6 (per contract).
 *
 * Wraps `net.Socket.prototype.connect` and `https.request` with
 * counter-incrementing proxies, boots a real relay in-process via
 * the workspace harness with NO connected clients and NO connected
 * agents, advances 10 simulated seconds via `vi.useFakeTimers()` /
 * `vi.advanceTimersByTime`, and asserts both counters are exactly
 * zero.
 *
 * On modern Node versions the `node:net` and `node:https` ESM
 * namespace bindings are non-configurable, so `vi.spyOn(...)` and
 * even `Object.defineProperty(...)` against the namespace fail with
 * "Cannot redefine property". The bind on the *prototype*
 * (`Socket.prototype.connect`) and on the underlying CJS export's
 * exposed object (via `require('node:https')`) is configurable, so
 * this test patches those paths instead. The technique is standard
 * for Node test instrumentation and is the same approach
 * `nock`-style libraries use.
 *
 * The relay opens its own LISTENING socket via `httpServer.listen(0)` —
 * that path goes through `net.createServer` and does NOT call
 * `Socket.prototype.connect`, so the listener does not register on the
 * counter. Only outbound egress (a DNS lookup, a third-party HTTPS POST,
 * etc.) would reach `Socket.prototype.connect` or `https.request`.
 *
 * Implements: R28.3, R28.4 — out-of-scope guarantee that the relay
 * does not exfiltrate prompts/responses or contact third-party
 * telemetry endpoints on its own.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as net from 'node:net';
import { createRequire } from 'node:module';
import { bootRelayInProcess, type RelayHarness } from './e2e/harness.js';

// ─── Lifecycle ────────────────────────────────────────────────────────────

let harness: RelayHarness;
let connectCallCount = 0;
let httpsRequestCallCount = 0;

/** Saved original `Socket.prototype.connect` so we can restore it. */
const origSocketConnect: typeof net.Socket.prototype.connect =
  net.Socket.prototype.connect;

/**
 * Pull the CJS https module via `createRequire` so the exposed object
 * is the patchable runtime exports rather than the ESM namespace
 * proxy. Node's CJS `https` exports object is mutable and supports
 * `Object.defineProperty` for the `request` slot.
 */
const requireCjs = createRequire(import.meta.url);
type HttpsModule = typeof import('node:https');
const httpsCjs = requireCjs('node:https') as HttpsModule;
const origHttpsRequest: HttpsModule['request'] = httpsCjs.request;

beforeAll(async () => {
  // Install fake timers FIRST so the relay's internal periodic timers
  // (AgentPool watcher, PendingQueue reaper, RateLimiter prune) are
  // intercepted by the fake clock. `httpServer.listen(0)` does not go
  // through setTimeout/setInterval so the bind itself is not affected.
  vi.useFakeTimers({ shouldAdvanceTime: false });

  // Patch `Socket.prototype.connect` to count outbound TCP connects.
  // Every Node TCP egress eventually goes through this method; the
  // wrapper records the call then delegates to the original so the
  // runtime stays functional.
  const wrappedConnect = function wrappedConnect(
    this: net.Socket,
    ...args: unknown[]
  ): net.Socket {
    connectCallCount += 1;
    return (origSocketConnect as (...a: unknown[]) => net.Socket).apply(
      this,
      args,
    );
  } as typeof net.Socket.prototype.connect;
  Object.defineProperty(net.Socket.prototype, 'connect', {
    value: wrappedConnect,
    writable: true,
    configurable: true,
  });

  // Patch the CJS `https.request` slot. The wrapper throws so any
  // accidental egress surfaces immediately during the test.
  const wrappedRequest = function wrappedRequest(): never {
    httpsRequestCallCount += 1;
    throw new Error('outbound-network test: https.request was called');
  } as unknown as HttpsModule['request'];
  Object.defineProperty(httpsCjs, 'request', {
    value: wrappedRequest,
    writable: true,
    configurable: true,
  });

  harness = await bootRelayInProcess();
});

afterAll(async () => {
  vi.useRealTimers();
  // Restore originals.
  Object.defineProperty(net.Socket.prototype, 'connect', {
    value: origSocketConnect,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(httpsCjs, 'request', {
    value: origHttpsRequest,
    writable: true,
    configurable: true,
  });
  if (harness !== undefined) {
    await harness.shutdown();
  }
});

// ─── Test ─────────────────────────────────────────────────────────────────

describe('outbound-network boundary (task 21.6)', () => {
  it('idle relay with no agents and no clients makes zero outbound TCP/HTTPS calls over 10 simulated seconds', async () => {
    expect(harness.agentPool.idle()).toHaveLength(0);
    expect(harness.pendingQueue.size()).toBe(0);

    // Reset the counters AFTER boot so any happy-path call the relay
    // made during construction (none expected, but defensively) does
    // not pollute the assertion.
    connectCallCount = 0;
    httpsRequestCallCount = 0;

    // 10 seconds of simulated time per the contract. The relay's
    // owned periodic timers are:
    //   - AgentPool heartbeat watcher (1 Hz) — pure local Map walks.
    //   - PendingQueue reaper (1 Hz) — pure local linked-list walks.
    //   - RateLimiter prune (every windowMs = 60 s default; this 10 s
    //     window does not fire its tick, but an extra fire would not
    //     be network-bound either).
    // None of these initiate an outbound connection.
    vi.advanceTimersByTime(10_000);

    // Pump the microtask queue a few rounds so any work the timer
    // tick scheduled has a chance to land before we measure.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(connectCallCount).toBe(0);
    expect(httpsRequestCallCount).toBe(0);
  });
});
