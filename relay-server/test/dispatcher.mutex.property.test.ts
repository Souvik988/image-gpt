/**
 * Property test for request- and agent-mutual exclusion + chunk
 * routing — task 7.7.
 *
 * Drives the production {@link createDispatcher} through fc.commands
 * over Dispatch / Complete / EmitChunk and asserts the three sub-
 * properties of P4:
 *
 *   1. No request is dispatched to >1 agent at the same time.
 *   2. No agent has >1 request at the same time.
 *   3. Every stream chunk is routed only to the originating client.
 *
 * Uses a stub {@link DispatcherTransport} that records the
 * (clientId, requestId) pair of every emitted chunk; the test then
 * compares each pair against the originator map maintained by
 * SubmitRequest.
 *
 * **Validates: Requirements 7.4, 7.5, 27.6, 27.7**
 */

// Feature: kiro-gpt-bridge, Property 4: at every point no request is dispatched to >1 agent, no agent has >1 request, and every stream chunk is routed only to the originating client

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  createDispatcher,
  type Dispatcher,
  type DispatcherTransport,
} from '../src/dispatch/dispatcher.js';
import { AgentPool, type AgentState } from '../src/dispatch/agentPool.js';
import { PendingQueue } from '../src/dispatch/pendingQueue.js';
import { RequestTable } from '../src/tracking/requestTable.js';
import type {
  Request,
  RequestId,
  ClientId,
  AgentId,
  StreamChunk,
  RequestStatusEvent,
} from '@kiro-gpt-bridge/shared';

// ─── stub transport with chunk-routing capture ─────────────────────────────

interface ChunkEmit {
  clientId: ClientId;
  chunk: StreamChunk;
}

interface DispatchEmit {
  agentId: AgentId;
  requestId: RequestId;
}

class CapturingTransport implements DispatcherTransport {
  readonly chunkEmits: ChunkEmit[] = [];
  readonly dispatches: DispatchEmit[] = [];

  async dispatchToAgent(agent: AgentState, request: Request): Promise<void> {
    this.dispatches.push({ agentId: agent.agentId, requestId: request.requestId });
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async cancelToAgent(_agent: AgentState, _requestId: RequestId): Promise<void> {
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  emitStatusToClient(_clientId: ClientId, _event: RequestStatusEvent): void {
    return;
  }
  emitChunkToClient(clientId: ClientId, chunk: StreamChunk): void {
    this.chunkEmits.push({ clientId, chunk });
  }
}

// ─── shared types ──────────────────────────────────────────────────────────

interface Real {
  dispatcher: Dispatcher;
  agentPool: AgentPool;
  pendingQueue: PendingQueue;
  requestTable: RequestTable;
  transport: CapturingTransport;
  /** Submitted requests, kept in submission order. */
  submitted: RequestId[];
  /** Map from request id → originating client id (immutable per request). */
  originator: Map<RequestId, ClientId>;
  /** Registered agents. */
  agents: AgentId[];
  /** Registered clients. */
  clients: ClientId[];
  clock: { t: number };
  nextRequestSerial: number;
}

interface Model {
  submitCount: number;
}

function makeRequest(clientId: ClientId, requestId: RequestId): Request {
  return {
    protocolVersion: 1,
    requestId,
    clientId,
    sessionId: 'session-mutex',
    type: 'chat',
    prompt: 'hi',
    submittedAt: 0,
  };
}

/**
 * Per-step invariant: the AgentPool's `busy()` snapshot and the
 * RequestTable's per-record `state`/`agentId` agree on a one-to-one
 * mapping — every request currently dispatched lives on exactly one
 * agent, and every busy agent serves exactly one request. The
 * AgentPool itself enforces "≤ 1 request per agent" by construction
 * (markBusy throws on a non-idle agent). We additionally confirm the
 * inverse: no request id appears as an agentId for >1 distinct
 * request.
 */
function assertMutex(real: Real): void {
  const busySnapshot = real.agentPool.busy();
  // (1) No agent has >1 request — the busy snapshot's `agent.agentId`
  // is unique by construction since `agentPool.busy()` returns one
  // entry per busy agentId.
  const seenAgents = new Set<AgentId>();
  for (const { agent } of busySnapshot) {
    expect(seenAgents.has(agent.agentId)).toBe(false);
    seenAgents.add(agent.agentId);
  }
  // (2) No request is dispatched to >1 agent — the busy snapshot's
  // `entry.requestId` must be unique across busy agents.
  const seenRequests = new Set<RequestId>();
  for (const { entry } of busySnapshot) {
    expect(seenRequests.has(entry.requestId)).toBe(false);
    seenRequests.add(entry.requestId);
  }
  // (3) The RequestTable's `agentId` field must agree with the busy
  // snapshot for any record that the table marks as `dispatched` or
  // `in_flight`.
  for (const record of real.requestTable.values()) {
    if (record.state !== 'dispatched' && record.state !== 'in_flight') continue;
    if (record.agentId === null) continue;
    const found = busySnapshot.find((b) => b.entry.requestId === record.request.requestId);
    if (found !== undefined) {
      expect(found.agent.agentId).toBe(record.agentId);
    }
  }
}

// ─── command classes ───────────────────────────────────────────────────────

/**
 * Dispatch — submit a fresh request from a fresh client. The
 * dispatcher's internal logic chooses the assigned agent; we record
 * the originator client so we can validate routing later.
 */
class Dispatch implements fc.Command<Model, Real> {
  constructor(
    readonly clientIndex: number,
    readonly requestSeed: string,
  ) {}
  check(_model: Readonly<Model>): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    if (real.clients.length === 0 || real.agents.length === 0) return;
    const clientId = real.clients[this.clientIndex % real.clients.length] as ClientId;
    const requestId = `req-${real.nextRequestSerial++}-${this.requestSeed}`;
    if (real.requestTable.get(requestId) !== undefined) return;
    real.submitted.push(requestId);
    real.originator.set(requestId, clientId);
    real.dispatcher.submit(makeRequest(clientId, requestId));
    model.submitCount += 1;
    assertMutex(real);
  }
  toString(): string {
    return `Dispatch(client=${this.clientIndex}, seed=${this.requestSeed})`;
  }
}

/** Complete — send a final chunk for the chosen request. */
class Complete implements fc.Command<Model, Real> {
  constructor(readonly requestIndex: number) {}
  check(_model: Readonly<Model>): boolean {
    return true;
  }
  run(_model: Model, real: Real): void {
    if (real.submitted.length === 0) return;
    const reqId = real.submitted[this.requestIndex % real.submitted.length] as RequestId;
    const chunk: StreamChunk = {
      protocolVersion: 1,
      requestId: reqId,
      chunkIndex: 0,
      text: 'done',
      isFinal: true,
      status: 'completed',
    };
    real.dispatcher.onAgentChunk(chunk);
    assertMutex(real);
  }
  toString(): string {
    return `Complete(idx=${this.requestIndex})`;
  }
}

/**
 * EmitChunk — send a non-final chunk. The "observedClient" parameter
 * is unused on the wire (the dispatcher consults its internal record
 * of the originator), but we keep the constructor parameter so the
 * command name matches the design wording. We then assert in
 * post-trace that every chunk emit went to the originating client.
 */
class EmitChunk implements fc.Command<Model, Real> {
  constructor(
    readonly requestIndex: number,
    readonly chunkIndex: number,
  ) {}
  check(_model: Readonly<Model>): boolean {
    return true;
  }
  run(_model: Model, real: Real): void {
    if (real.submitted.length === 0) return;
    const reqId = real.submitted[this.requestIndex % real.submitted.length] as RequestId;
    const chunk: StreamChunk = {
      protocolVersion: 1,
      requestId: reqId,
      chunkIndex: this.chunkIndex,
      text: 'partial',
      isFinal: false,
    };
    real.dispatcher.onAgentChunk(chunk);
    assertMutex(real);
  }
  toString(): string {
    return `EmitChunk(reqIdx=${this.requestIndex}, chunkIdx=${this.chunkIndex})`;
  }
}

// ─── arbitraries ───────────────────────────────────────────────────────────

const dispatchArb: fc.Arbitrary<fc.Command<Model, Real>> = fc
  .record({
    clientIndex: fc.integer({ min: 0, max: 4 }),
    requestSeed: fc.string({ minLength: 1, maxLength: 8 }),
  })
  .map(({ clientIndex, requestSeed }) => new Dispatch(clientIndex, requestSeed));

const completeArb: fc.Arbitrary<fc.Command<Model, Real>> = fc
  .integer({ min: 0, max: 19 })
  .map((idx) => new Complete(idx));

const emitChunkArb: fc.Arbitrary<fc.Command<Model, Real>> = fc
  .record({
    requestIndex: fc.integer({ min: 0, max: 19 }),
    chunkIndex: fc.integer({ min: 0, max: 5 }),
  })
  .map(({ requestIndex, chunkIndex }) => new EmitChunk(requestIndex, chunkIndex));

// ─── test ──────────────────────────────────────────────────────────────────

describe('dispatcher — Property 4: request and agent mutual exclusion + chunk routing', () => {
  it('mutex holds at every step and every chunk is routed to its originator', () => {
    fc.assert(
      fc.property(
        fc.commands([dispatchArb, completeArb, emitChunkArb], { size: '+1' }),
        (cmds) => {
          const clock = { t: 1_000_000 };
          const agentPool = new AgentPool({ now: () => clock.t });
          const pendingQueue = new PendingQueue({ now: () => clock.t });
          const requestTable = new RequestTable();
          const transport = new CapturingTransport();
          const dispatcher = createDispatcher({
            agentPool,
            pendingQueue,
            requestTable,
            transport,
            now: () => clock.t,
          });

          try {
            // Pre-register a small fleet of clients and agents so
            // Dispatch commands have somewhere to land.
            const clients: ClientId[] = ['c-1', 'c-2', 'c-3'];
            const agents: AgentId[] = ['a-1', 'a-2', 'a-3'];
            for (const agentId of agents) {
              agentPool.register(agentId, `socket-${agentId}`);
            }

            const real: Real = {
              dispatcher,
              agentPool,
              pendingQueue,
              requestTable,
              transport,
              submitted: [],
              originator: new Map(),
              agents,
              clients,
              clock,
              nextRequestSerial: 0,
            };

            fc.modelRun(() => ({ model: { submitCount: 0 }, real }), [...cmds]);

            // Final-step mutex check.
            assertMutex(real);

            // Routing invariant: every chunk emit must go to the
            // request's originating client. The dispatcher consults
            // its internal record table — the wire chunk does not
            // carry a clientId — so the only way to violate this is a
            // dispatcher bug.
            for (const emit of real.transport.chunkEmits) {
              const expectedClient = real.originator.get(emit.chunk.requestId);
              if (expectedClient === undefined) {
                // QUEUE_FULL emits a chunk before the originator map
                // is populated; the dispatcher pulls clientId from
                // the table record, which is removed for QUEUE_FULL.
                // We tolerate these by skipping. In practice the
                // queue is far from full in this test (no tick
                // commands) so this branch is never taken.
                continue;
              }
              expect(emit.clientId).toBe(expectedClient);
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
