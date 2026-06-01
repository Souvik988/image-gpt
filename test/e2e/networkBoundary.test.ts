/**
 * Outbound-network boundary test — task 21.6.
 *
 * Wraps `net.createConnection`, `http.request`, and `https.request`
 * with a recording shim, boots the relay in-process with NO connected
 * agents and NO connected clients, advances 10 s of simulated time
 * via `vi.useFakeTimers()`, and asserts the recording has zero
 * entries — i.e. an idle relay never reaches out to the network on
 * its own.
 *
 * The relay is allowed (and required) to OPEN the local listening
 * socket so clients could in principle connect; that path goes through
 * `httpServer.listen` and `net.createServer`, neither of which is on
 * the watched outbound-egress list. The shims only fire when the
 * relay (or anything else inside the test process) initiates an
 * outbound connection.
 *
 * Implementation notes:
 *
 *  1. `vi.useFakeTimers()` is installed BEFORE booting the relay so
 *     the internal periodic timers held by {@link AgentPool},
 *     {@link PendingQueue}, and the rate limiter are intercepted by
 *     the fake clock. Advancing 10 simulated seconds therefore fires
 *     every periodic tick the relay owns inside the watched window.
 *     The HTTP listener bind (`httpServer.listen`) does NOT go through
 *     `setTimeout`/`setInterval`, so fake timers do not interfere with
 *     the relay coming up.
 *
 *  2. The original `net.createConnection` / `http.request` /
 *     `https.request` references are captured BEFORE installing the
 *     spies, then invoked from inside the spy implementation. This
 *     keeps the runtime functional (legitimate egress, if any, still
 *     reaches the network) while every call is recorded — the
 *     recording, not the act of egress, is what the test asserts on.
 *
 * Implements: R28.3, R28.4 — out-of-scope guarantee that the relay
 * does not exfiltrate prompts/responses or contact third-party
 * telemetry endpoints on its own.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { bootRelayInProcess, type RelayHarness } from './harness.js';

/**
 * One observed outbound-network call. We capture enough context to
 * surface a useful failure message if the assertion ever trips.
 */
interface OutboundEntry {
  /** Which Node API initiated the egress. */
  api: 'net.createConnection' | 'http.request' | 'https.request';
  /** Best-effort host:port summary derived from the API arguments. */
  target: string;
  /** ISO 8601 timestamp at the moment of the call. */
  at: string;
}

/**
 * Best-effort extraction of a `host:port` summary from the arguments
 * passed to one of the watched egress APIs. The Node surface is varied
 * (positional vs. options object, URL string vs. URL object, IPC
 * paths); this helper never throws.
 */
function summarize(args: readonly unknown[]): string {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (typeof first === 'number') return `port:${first}`;
  if (first !== null && typeof first === 'object') {
    const obj = first as Record<string, unknown>;
    if (typeof obj.href === 'string') return obj.href;
    const host =
      typeof obj.host === 'string'
        ? obj.host
        : typeof obj.hostname === 'string'
          ? obj.hostname
          : typeof obj.path === 'string'
            ? `unix:${obj.path}`
            : '<unknown>';
    const port =
      typeof obj.port === 'number' || typeof obj.port === 'string'
        ? `:${String(obj.port)}`
        : '';
    return `${host}${port}`;
  }
  return '<unknown>';
}

// ─── Lifecycle ────────────────────────────────────────────────────────────

let harness: RelayHarness;
const recording: OutboundEntry[] = [];

beforeAll(async () => {
  // Install fake timers FIRST so the relay's internal periodic timers
  // (AgentPool watcher, PendingQueue reaper, RateLimiter prune) are
  // intercepted by the fake clock. `httpServer.listen(0)` does not go
  // through setTimeout/setInterval so the bind itself is not affected.
  vi.useFakeTimers({ shouldAdvanceTime: false });

  // Capture the originals BEFORE installing the spies so the spy
  // implementations can delegate without recursing back into themselves.
  const origNetCreateConnection: typeof net.createConnection =
    net.createConnection.bind(net);
  const origHttpRequest: typeof http.request = http.request.bind(http);
  const origHttpsRequest: typeof https.request = https.request.bind(https);

  // `net.createConnection` has 7 overloaded signatures; using
  // `Parameters<...>` resolves to the *last* overload only, which is
  // why the implementation accepts `unknown[]` and casts at the call
  // site. The cast is safe because we forward args verbatim and the
  // underlying Node implementation is what does the dispatch.
  vi.spyOn(net, 'createConnection').mockImplementation(
    ((...args: unknown[]) => {
      recording.push({
        api: 'net.createConnection',
        target: summarize(args),
        at: new Date().toISOString(),
      });
      return (origNetCreateConnection as (...a: unknown[]) => net.Socket)(
        ...args,
      );
    }) as typeof net.createConnection,
  );

  vi.spyOn(http, 'request').mockImplementation(
    ((...args: unknown[]) => {
      recording.push({
        api: 'http.request',
        target: summarize(args),
        at: new Date().toISOString(),
      });
      return (origHttpRequest as (...a: unknown[]) => http.ClientRequest)(
        ...args,
      );
    }) as typeof http.request,
  );

  vi.spyOn(https, 'request').mockImplementation(
    ((...args: unknown[]) => {
      recording.push({
        api: 'https.request',
        target: summarize(args),
        at: new Date().toISOString(),
      });
      return (origHttpsRequest as (...a: unknown[]) => http.ClientRequest)(
        ...args,
      );
    }) as typeof https.request,
  );

  harness = await bootRelayInProcess();
});

afterAll(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (harness !== undefined) {
    await harness.shutdown();
  }
});

// ─── Test ─────────────────────────────────────────────────────────────────

describe('e2e outbound-network boundary (task 21.6)', () => {
  it('idle relay with no agents and no clients makes zero outbound calls over 10 simulated seconds', async () => {
    expect(harness.agentPool.idle()).toHaveLength(0);
    expect(harness.pendingQueue.size()).toBe(0);

    // 10 seconds of simulated time per the spec instruction. The
    // relay's owned periodic timers are:
    //   - AgentPool heartbeat watcher (1 Hz) — pure local Map walks.
    //   - PendingQueue reaper (1 Hz) — pure local linked-list walks.
    //   - RateLimiter prune (every windowMs = 60 s default; this 10 s
    //     window does not fire its tick, but an extra fire would not
    //     be network-bound either).
    // None of these initiate an outbound connection.
    vi.advanceTimersByTime(10_000);

    // Run any microtasks the synchronous timer fan-out queued.
    // `vi.advanceTimersByTime` does not flush microtasks itself; a
    // few awaited `Promise.resolve()`s pump the microtask queue.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(recording).toEqual([]);
  });
});
