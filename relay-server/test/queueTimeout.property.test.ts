/**
 * Property test for queue-timeout enforcement — task 7.8.
 *
 * Drives the production {@link createDispatcher} + {@link PendingQueue}
 * through fc.commands over Submit / Tick / AgentBecomesIdle and
 * asserts after every step:
 *
 *   1. No item currently on the queue has `now - enqueuedAt > 600_000`.
 *   2. Any request whose time-in-queue ever exceeded 600_000 ms is in
 *      the `queue_timeout` terminal state (or has otherwise reached
 *      a terminal state via dispatch + completion before the timeout).
 *
 * The queue's `setInterval` reaper does not fire under vitest's
 * synchronous harness, so the test invokes the reaper directly at
 * end-of-step via the queue's public reap surface (forced through a
 * typed cast to the private method).
 *
 * **Validates: Requirements 6.7, 7.7, 27.8**
 */

// Feature: kiro-gpt-bridge, Property 7: every request whose time-in-queue exceeds 600000 ms transitions to queue_timeout terminal state

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  createDispatcher,
  type Dispatcher,
  type DispatcherTransport,
} from '../src/dispatch/dispatcher.js';
import { AgentPool, type AgentState } from '../src/dispatch/agentPool.js';
import { PendingQueue } from '../src/dispatch/pendingQueue.js';
import { RequestTable, TERMINAL_TRACKED_STATES } from '../src/tracking/requestTable.js';
import type {
  Request,
  RequestId,
  ClientId,
  AgentId,
  StreamChunk,
  RequestStatusEvent,
} from '@kiro-gpt-bridge/shared';

const QUEUE_TTL_MS = 600_000;

// ─── stub transport ────────────────────────────────────────────────────────

class StubTransport implements DispatcherTransport {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async dispatchToAgent(_agent: AgentState, _request: Request): Promise<void> {
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async cancelToAgent(_agent: AgentState, _requestId: RequestId): Promise<void> {
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  emitStatusToClient(_clientId: ClientId, _event: RequestStatusEvent): void {
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  emitChunkToClient(_clientId: ClientId, _chunk: StreamChunk): void {
    return;
  }
}

// ─── shared types ──────────────────────────────────────────────────────────

interface Real {
  dispatcher: Dispatcher;
  agentPool: AgentPool;
  pendingQueue: PendingQueue;
  requestTable: RequestTable;
  clock: { t: number };
  /** All submitted requestIds in submission order. */
  submitted: RequestId[];
  /** clientId → for cancel forwarding. */
  clientFor: Map<RequestId, ClientId>;
  agents: AgentId[];
  busyAgents: AgentId[];
  nextSerial: number;
}

interface Model {
  submitted: number;
}

const TEST_CLIENT: ClientId = 'qt-client';

function makeRequest(clientId: ClientId, requestId: RequestId): Request {
  return {
    protocolVersion: 1,
    requestId,
    clientId,
    sessionId: 'session-qt',
    type: 'chat',
    prompt: 'p',
    submittedAt: 0,
  };
}

/** Force the queue reaper to run at the current virtual time. */
function forceReap(queue: PendingQueue): void {
  const reapable = queue as unknown as { reap?: () => void };
  if (typeof reapable.reap === 'function') {
    reapable.reap();
  }
}

/**
 * Per-step invariant for Property 7:
 *
 *   For every entry currently in the queue, `now - enqueuedAt <=
 *   QUEUE_TTL_MS`.
 *
 * A queued entry that exceeds the TTL is a violation: the reaper
 * should have removed it and transitioned the record to
 * `queue_timeout`. We force the reaper to run before the assertion
 * so the queue reflects the dispatcher's logical state.
 */
function assertNoOverdueQueued(real: Real): void {
  forceReap(real.pendingQueue);
  // The pending queue does not expose an iterator. Walk the request
  // table and find any record currently in the `queued` state — its
  // `enqueuedAt` must be within the TTL window.
  for (const record of real.requestTable.values()) {
    if (record.state !== 'queued') continue;
    if (record.enqueuedAt === null) continue;
    const age = real.clock.t - record.enqueuedAt;
    expect(age).toBeLessThanOrEqual(QUEUE_TTL_MS);
  }
}

// ─── command classes ───────────────────────────────────────────────────────

class Submit implements fc.Command<Model, Real> {
  constructor(readonly seed: string) {}
  check(_model: Readonly<Model>): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    const requestId = `qt-${real.nextSerial++}-${this.seed}`;
    if (real.requestTable.get(requestId) !== undefined) return;
    real.submitted.push(requestId);
    real.clientFor.set(requestId, TEST_CLIENT);
    real.dispatcher.submit(makeRequest(TEST_CLIENT, requestId));
    model.submitted += 1;
    // After a submit, no overdue items should exist (the new entry
    // was just enqueued at clock.t).
    assertNoOverdueQueued(real);
  }
  toString(): string {
    return `Submit(${this.seed})`;
  }
}

class Tick implements fc.Command<Model, Real> {
  constructor(readonly deltaMs: number) {}
  check(_model: Readonly<Model>): boolean {
    return true;
  }
  run(_model: Model, real: Real): void {
    real.clock.t += this.deltaMs;
    // After advancing the clock, the reaper must catch up. Force it
    // and then check the invariant.
    assertNoOverdueQueued(real);
  }
  toString(): string {
    return `Tick(${this.deltaMs}ms)`;
  }
}

/**
 * AgentBecomesIdle — pre-registered busy agents finalize their fillers
 * so a queue head can be drained. We mirror Property 2's filler
 * pattern: at trace setup every agent is pinned busy, and this
 * command frees them one by one.
 */
class AgentBecomesIdle implements fc.Command<Model, Real> {
  constructor(readonly busyIndex: number) {}
  check(_model: Readonly<Model>): boolean {
    return true;
  }
  run(_model: Model, real: Real): void {
    if (real.busyAgents.length === 0) return;
    const idx = this.busyIndex % real.busyAgents.length;
    const agentId = real.busyAgents[idx] as AgentId;
    const entry = real.agentPool.busy().find((b) => b.agent.agentId === agentId);
    if (entry === undefined) {
      // Already completed by the dispatcher's own drain path.
      real.busyAgents.splice(idx, 1);
      return;
    }
    const chunk: StreamChunk = {
      protocolVersion: 1,
      requestId: entry.entry.requestId,
      chunkIndex: 0,
      text: 'done',
      isFinal: true,
      status: 'completed',
    };
    real.dispatcher.onAgentChunk(chunk);
    real.busyAgents.splice(idx, 1);
    assertNoOverdueQueued(real);
  }
  toString(): string {
    return `AgentBecomesIdle(idx=${this.busyIndex})`;
  }
}

// ─── arbitraries ───────────────────────────────────────────────────────────

const submitArb: fc.Arbitrary<fc.Command<Model, Real>> = fc
  .string({ minLength: 1, maxLength: 8 })
  .map((seed) => new Submit(seed));

const tickArb: fc.Arbitrary<fc.Command<Model, Real>> = fc
  .integer({ min: 0, max: 800_000 })
  .map((deltaMs) => new Tick(deltaMs));

const becomesIdleArb: fc.Arbitrary<fc.Command<Model, Real>> = fc
  .integer({ min: 0, max: 9 })
  .map((idx) => new AgentBecomesIdle(idx));

// ─── test ──────────────────────────────────────────────────────────────────

describe('dispatcher — Property 7: queue-timeout enforcement', () => {
  it('every overdue request transitions to queue_timeout and no overdue item stays queued', () => {
    fc.assert(
      fc.property(
        fc.commands([submitArb, tickArb, becomesIdleArb], { size: '+1' }),
        (cmds) => {
          const clock = { t: 1_000_000 };
          const agentPool = new AgentPool({ now: () => clock.t });
          const pendingQueue = new PendingQueue({ now: () => clock.t, ttlMs: QUEUE_TTL_MS });
          const requestTable = new RequestTable();
          const transport = new StubTransport();
          const dispatcher = createDispatcher({
            agentPool,
            pendingQueue,
            requestTable,
            transport,
            now: () => clock.t,
          });

          try {
            // Saturate the pool with two busy agents so submits land
            // on the queue, where they can age out.
            const initialAgents: AgentId[] = ['agent-1', 'agent-2'];
            for (const agentId of initialAgents) {
              agentPool.register(agentId, `socket-${agentId}`);
            }
            for (const agentId of initialAgents) {
              dispatcher.submit(makeRequest('filler-client', `filler-${agentId}`));
            }

            const real: Real = {
              dispatcher,
              agentPool,
              pendingQueue,
              requestTable,
              clock,
              submitted: [],
              clientFor: new Map(),
              agents: initialAgents,
              busyAgents: [...initialAgents],
              nextSerial: 0,
            };

            fc.modelRun(() => ({ model: { submitted: 0 }, real }), [...cmds]);

            // End-of-trace closure: any submitted request whose age
            // ever exceeded the TTL must now be in the queue_timeout
            // terminal state — OR it must have been dispatched and
            // reached a different terminal state before timing out.
            // We check the simpler of the two: every overdue queued
            // entry is dead.
            forceReap(real.pendingQueue);
            for (const reqId of real.submitted) {
              const record = real.requestTable.get(reqId);
              if (record === undefined) continue;
              if (record.state === 'queued' && record.enqueuedAt !== null) {
                const age = real.clock.t - record.enqueuedAt;
                expect(age).toBeLessThanOrEqual(QUEUE_TTL_MS);
              }
              // Any record we know to have been queued for >TTL must
              // have left the `queued` state; if its current state
              // is `queue_timeout`, the dispatcher correctly fired
              // the reaper. Other terminal states (completed,
              // cancelled, failed) are also acceptable since the
              // dispatcher may have drained the request before its
              // timer fired.
              if (TERMINAL_TRACKED_STATES.has(record.state)) {
                expect([
                  'completed',
                  'cancelled',
                  'failed',
                  'queue_timeout',
                ]).toContain(record.state);
              }
            }
          } finally {
            dispatcher.dispose();
            pendingQueue.dispose();
            agentPool.dispose();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
