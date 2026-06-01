/**
 * Integration test for cancel paths — task 7.9.
 *
 * Boots the dispatcher with a stub {@link DispatcherTransport} acting
 * as a "mock agent" + "mock client" pair. Exercises:
 *
 *   1. Queued cancel — a request pinned in the pending queue must
 *      transition to `cancelled` and emit a final stream chunk to the
 *      originating client within 1 s of the cancel call.
 *   2. In-flight cancel — a dispatched request is forwarded to the
 *      mock agent within 1 s of the cancel call (the transport
 *      records the cancel-to-agent arrival).
 *   3. Cancel undeliverable — when the agent never produces a final
 *      chunk and the cancel-delivery deadline (5 s, R20.7) lapses,
 *      the request transitions to `failed` with errorCode
 *      `CANCEL_DELIVERY_FAILED`.
 *
 * Implements R20.3, R20.4, R20.5, R20.6, R20.7.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createDispatcher,
  type Dispatcher,
  type DispatcherTransport,
} from '../../src/dispatch/dispatcher.js';
import { AgentPool, type AgentState } from '../../src/dispatch/agentPool.js';
import { PendingQueue } from '../../src/dispatch/pendingQueue.js';
import { RequestTable } from '../../src/tracking/requestTable.js';
import type {
  Request,
  RequestId,
  ClientId,
  StreamChunk,
  RequestStatusEvent,
} from '@kiro-gpt-bridge/shared';

interface ChunkLog {
  clientId: ClientId;
  chunk: StreamChunk;
  /** Virtual time when the emit landed. */
  emittedAt: number;
}

interface CancelLog {
  agentId: string;
  requestId: RequestId;
  /** Virtual time when the cancel-to-agent landed. */
  emittedAt: number;
}

/**
 * Stub transport doubling as a mock-agent + mock-client recorder.
 * `dispatchToAgent` always succeeds; `cancelToAgent` records the
 * arrival time so the test can assert a <1 s deadline.
 */
class CancelTestTransport implements DispatcherTransport {
  readonly chunks: ChunkLog[] = [];
  readonly cancels: CancelLog[] = [];
  /**
   * When set, `cancelToAgent` rejects synchronously without recording
   * — used to drive the "cancel undeliverable" path. The dispatcher
   * uses the cancelTimeoutMs deadline as the authoritative deadline,
   * so even silent rejection is enough.
   */
  failCancel = false;

  constructor(private readonly clock: { t: number }) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async dispatchToAgent(_agent: AgentState, _request: Request): Promise<void> {
    return;
  }
  async cancelToAgent(agent: AgentState, requestId: RequestId): Promise<void> {
    if (this.failCancel) {
      throw new Error('mock: cancel undeliverable');
    }
    this.cancels.push({
      agentId: agent.agentId,
      requestId,
      emittedAt: this.clock.t,
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  emitStatusToClient(_clientId: ClientId, _event: RequestStatusEvent): void {
    return;
  }
  emitChunkToClient(clientId: ClientId, chunk: StreamChunk): void {
    this.chunks.push({ clientId, chunk, emittedAt: this.clock.t });
  }
}

// ─── shared fixture ────────────────────────────────────────────────────────

const TEST_CLIENT: ClientId = 'cancel-test-client';
const TEST_AGENT = 'cancel-test-agent';

function makeRequest(requestId: RequestId): Request {
  return {
    protocolVersion: 1,
    requestId,
    clientId: TEST_CLIENT,
    sessionId: 'session-cancel',
    type: 'chat',
    prompt: 'hello',
    submittedAt: 0,
  };
}

interface Fixture {
  clock: { t: number };
  dispatcher: Dispatcher;
  agentPool: AgentPool;
  pendingQueue: PendingQueue;
  requestTable: RequestTable;
  transport: CancelTestTransport;
}

function buildFixture(): Fixture {
  const clock = { t: 1_000_000 };
  const agentPool = new AgentPool({ now: () => clock.t });
  const pendingQueue = new PendingQueue({ now: () => clock.t });
  const requestTable = new RequestTable();
  const transport = new CancelTestTransport(clock);
  const dispatcher = createDispatcher({
    agentPool,
    pendingQueue,
    requestTable,
    transport,
    now: () => clock.t,
    // Cancel deadline kept at the design default (R20.7) so our timing
    // assertions exercise the real behavior. The fc-style virtual
    // clock cannot fire setTimeout's natively, so the undeliverable
    // case uses a real (short) wait; see the test below.
  });
  return { clock, dispatcher, agentPool, pendingQueue, requestTable, transport };
}

let fx: Fixture;

beforeEach(() => {
  fx = buildFixture();
});

afterEach(() => {
  fx.dispatcher.dispose();
  fx.pendingQueue.dispose();
  fx.agentPool.dispose();
});

// Wait for the dispatcher's async `dispatchToAgent` micro-task chain
// to drain — needed because tryDispatch awaits the transport call.
async function flushMicrotasks(): Promise<void> {
  // Two rounds is enough for our stub which resolves synchronously.
  await Promise.resolve();
  await Promise.resolve();
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe('cancel paths — task 7.9', () => {
  it('queued cancel: emits final cancelled chunk to client within 1s and removes from queue (R20.5)', async () => {
    // No idle agent → submit lands on the queue.
    const requestId: RequestId = 'req-queued-cancel';
    fx.dispatcher.submit(makeRequest(requestId));
    await flushMicrotasks();

    expect(fx.pendingQueue.size()).toBe(1);
    expect(fx.requestTable.get(requestId)?.state).toBe('queued');

    const cancelStart = fx.clock.t;
    fx.dispatcher.cancel(requestId, TEST_CLIENT);
    // Dispatcher cancel for the queued case is fully synchronous.
    fx.clock.t += 50; // 50 ms later

    expect(fx.pendingQueue.size()).toBe(0);
    expect(fx.requestTable.get(requestId)?.state).toBe('cancelled');

    // R20.5 — final chunk emitted to the originating client.
    const finalChunk = fx.transport.chunks.find(
      (c) => c.chunk.requestId === requestId && c.chunk.isFinal,
    );
    expect(finalChunk).toBeDefined();
    expect(finalChunk?.clientId).toBe(TEST_CLIENT);
    expect(finalChunk?.chunk.status).toBe('cancelled');
    // Within 1 s — we're well under that with our synchronous +50 ms tick.
    expect((finalChunk?.emittedAt ?? Infinity) - cancelStart).toBeLessThanOrEqual(1_000);
  });

  it('in-flight cancel: forwarded to mock agent within 1 s (R20.3)', async () => {
    // Register a single agent so the submit dispatches immediately.
    fx.agentPool.register(TEST_AGENT, 'socket-test-agent');
    const requestId: RequestId = 'req-in-flight-cancel';
    fx.dispatcher.submit(makeRequest(requestId));
    await flushMicrotasks();

    // Confirm the request is dispatched/in-flight, not queued.
    const recordBeforeCancel = fx.requestTable.get(requestId);
    expect(recordBeforeCancel).toBeDefined();
    expect(['dispatched', 'in_flight']).toContain(recordBeforeCancel?.state);

    const cancelStart = fx.clock.t;
    fx.dispatcher.cancel(requestId, TEST_CLIENT);
    await flushMicrotasks();
    fx.clock.t += 200; // 200 ms later — well under the 1 s deadline

    // R20.3 — the cancel was forwarded to the assigned agent.
    const cancelToAgent = fx.transport.cancels.find((c) => c.requestId === requestId);
    expect(cancelToAgent).toBeDefined();
    expect(cancelToAgent?.agentId).toBe(TEST_AGENT);
    expect((cancelToAgent?.emittedAt ?? Infinity) - cancelStart).toBeLessThanOrEqual(1_000);

    // The record should be in `cancelling` until the agent acks via a
    // final chunk (or the cancel deadline fires).
    expect(fx.requestTable.get(requestId)?.state).toBe('cancelling');
  });

  it('cancel undeliverable: transitions to failed with CANCEL_DELIVERY_FAILED after 5s (R20.7)', async () => {
    // Use a SHORT cancel timeout so the test runs quickly. We rebuild
    // the fixture with a 30 ms cancel deadline; the dispatcher's R20.7
    // semantics are preserved — the value of the deadline is a config
    // knob and the property-of-interest is that the timer fires.
    fx.dispatcher.dispose();
    fx.pendingQueue.dispose();
    fx.agentPool.dispose();

    const clock = { t: 1_000_000 };
    const agentPool = new AgentPool({ now: () => clock.t });
    const pendingQueue = new PendingQueue({ now: () => clock.t });
    const requestTable = new RequestTable();
    const transport = new CancelTestTransport(clock);
    const dispatcher = createDispatcher({
      agentPool,
      pendingQueue,
      requestTable,
      transport,
      now: () => clock.t,
      cancelTimeoutMs: 30,
    });
    fx = { clock, dispatcher, agentPool, pendingQueue, requestTable, transport };

    fx.agentPool.register(TEST_AGENT, 'socket-test-agent');
    const requestId: RequestId = 'req-cancel-undeliverable';
    fx.dispatcher.submit(makeRequest(requestId));
    await flushMicrotasks();

    // Force the cancelToAgent to silently fail. The deadline timer is
    // the authoritative deadline — even a successful network send is
    // followed by a 5 s wait for the agent to actually deliver a
    // final chunk; the timer fires regardless.
    fx.transport.failCancel = true;
    fx.dispatcher.cancel(requestId, TEST_CLIENT);
    await flushMicrotasks();

    // Wait for the real-time cancel-deadline timer to fire. We use a
    // short real wait that comfortably exceeds the configured 30 ms.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 100);
      t.unref?.();
    });

    const finalChunk = fx.transport.chunks
      .filter((c) => c.chunk.requestId === requestId && c.chunk.isFinal)
      .at(-1);
    expect(finalChunk).toBeDefined();
    expect(finalChunk?.chunk.status).toBe('failed');
    expect(finalChunk?.chunk.errorCode).toBe('CANCEL_DELIVERY_FAILED');
    expect(fx.requestTable.get(requestId)?.state).toBe('failed');
  });

  it('cancel of unknown id is a silent no-op (R20.6)', () => {
    fx.dispatcher.cancel('nonexistent-id', TEST_CLIENT);
    expect(fx.transport.chunks).toHaveLength(0);
    expect(fx.requestTable.size()).toBe(0);
  });
});
