/**
 * Property test for agent-pool state consistency — task 7.6.
 *
 * Drives the production {@link AgentPool} through fc.commands over
 * registration / disconnect / dispatch / completion / login_required
 * / recovery and asserts after every action that:
 *
 *   |idle| + |busy| + |loginRequired| == |registered|
 *   the three categories are pairwise disjoint
 *   disconnected agents are not in any registered category
 *
 * The "registered" total is the size of the union {idle ∪ busy ∪
 * login_required} — i.e. every agent that the pool currently tracks.
 * Disconnected agents have already been removed from internal maps so
 * their non-membership is the disjointness condition.
 *
 * **Validates: Requirements 3.1, 3.5, 5.3, 7.1, 27.3**
 */

// Feature: kiro-gpt-bridge, Property 3: |busy| + |idle| + |loginRequired| == |registered| with pairwise-disjoint sets and disconnected ∩ registered == ∅

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { AgentPool, type AgentState } from '../src/dispatch/agentPool.js';
import type { AgentId } from '@kiro-gpt-bridge/shared';

// ─── shared types ──────────────────────────────────────────────────────────

interface Real {
  pool: AgentPool;
  /** Agents the pool currently has in any non-disconnected category. */
  knownAgents: Set<AgentId>;
  /** Agents that have ever been disconnected — must stay out of the pool. */
  disconnected: Set<AgentId>;
  /** Currently-busy agentIds, mirrored by markBusy/markIdle commands. */
  busyAssignment: Map<AgentId, string>;
  /** Counter for unique agent ids minted by RegisterAgent. */
  nextRequestId: number;
}

interface Model {
  registeredCount: number;
}

/**
 * Run the invariant after every command. Reads only public AgentPool
 * accessors so we never reach into private fields.
 */
function assertInvariant(real: Real): void {
  const idleSet = new Set<AgentId>(real.pool.idle().map((s: AgentState) => s.agentId));
  const busySet = new Set<AgentId>(real.pool.busy().map((b) => b.agent.agentId));

  // login_required cannot be enumerated directly — derive it as
  // (knownAgents − idle − busy). Every knownAgent must be in exactly
  // one of these three categories, and disconnected agents must be in
  // none of them.
  const loginRequiredSet = new Set<AgentId>();
  for (const agentId of real.knownAgents) {
    if (!idleSet.has(agentId) && !busySet.has(agentId)) {
      loginRequiredSet.add(agentId);
    }
  }

  // Pairwise disjoint between idle / busy.
  for (const id of idleSet) {
    expect(busySet.has(id)).toBe(false);
  }
  // login_required is by construction the complement, so it cannot
  // overlap idle or busy. Still, double-check that every knownAgent
  // landed in exactly one bucket.
  for (const agentId of real.knownAgents) {
    const inIdle = idleSet.has(agentId) ? 1 : 0;
    const inBusy = busySet.has(agentId) ? 1 : 0;
    const inLoginRequired = loginRequiredSet.has(agentId) ? 1 : 0;
    expect(inIdle + inBusy + inLoginRequired).toBe(1);
  }

  // |busy| + |idle| + |loginRequired| == |registered| (union of all
  // non-disconnected categories).
  expect(idleSet.size + busySet.size + loginRequiredSet.size).toBe(real.knownAgents.size);

  // disconnected ∩ registered == ∅ — every disconnected agent must
  // have been physically removed from the pool's `get`.
  for (const agentId of real.disconnected) {
    expect(real.pool.get(agentId)).toBeUndefined();
    expect(real.knownAgents.has(agentId)).toBe(false);
  }
}

// ─── command classes ───────────────────────────────────────────────────────

class RegisterAgentCmd implements fc.Command<Model, Real> {
  constructor(readonly agentId: AgentId) {}
  check(_model: Readonly<Model>): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    if (real.knownAgents.has(this.agentId) || real.disconnected.has(this.agentId)) {
      // Re-using an agentId after a disconnect is forbidden by the
      // pool API contract (R3.5: a fresh agentId on every reconnect).
      // Skip rather than throw so the trace can keep exploring.
      return;
    }
    real.pool.register(this.agentId, `socket-${this.agentId}`);
    real.knownAgents.add(this.agentId);
    model.registeredCount += 1;
    assertInvariant(real);
  }
  toString(): string {
    return `RegisterAgent(${this.agentId})`;
  }
}

class DisconnectAgentCmd implements fc.Command<Model, Real> {
  constructor(readonly agentIndex: number) {}
  check(_model: Readonly<Model>): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    const known = [...real.knownAgents];
    if (known.length === 0) return;
    const agentId = known[this.agentIndex % known.length] as AgentId;
    real.pool.disconnect(agentId);
    real.knownAgents.delete(agentId);
    real.disconnected.add(agentId);
    real.busyAssignment.delete(agentId);
    model.registeredCount -= 1;
    assertInvariant(real);
  }
  toString(): string {
    return `DisconnectAgent(idx=${this.agentIndex})`;
  }
}

/** Mark an idle agent busy on a fresh request — equivalent to dispatch. */
class DispatchCmd implements fc.Command<Model, Real> {
  constructor(readonly agentIndex: number) {}
  check(_model: Readonly<Model>): boolean {
    return true;
  }
  run(_model: Model, real: Real): void {
    const idleAgents = real.pool.idle();
    if (idleAgents.length === 0) return;
    const agent = idleAgents[this.agentIndex % idleAgents.length] as AgentState;
    const requestId = `req-${real.nextRequestId++}`;
    real.pool.markBusy(agent.agentId, requestId);
    real.busyAssignment.set(agent.agentId, requestId);
    assertInvariant(real);
  }
  toString(): string {
    return `Dispatch(idleIdx=${this.agentIndex})`;
  }
}

/** A busy agent emits its final chunk — moves back to idle. */
class AgentChunkFinalCmd implements fc.Command<Model, Real> {
  constructor(readonly busyIndex: number) {}
  check(_model: Readonly<Model>): boolean {
    return true;
  }
  run(_model: Model, real: Real): void {
    const busy = real.pool.busy();
    if (busy.length === 0) return;
    const target = busy[this.busyIndex % busy.length];
    if (target === undefined) return;
    real.pool.markIdle(target.agent.agentId);
    real.busyAssignment.delete(target.agent.agentId);
    assertInvariant(real);
  }
  toString(): string {
    return `AgentChunkFinal(busyIdx=${this.busyIndex})`;
  }
}

class LoginRequiredCmd implements fc.Command<Model, Real> {
  constructor(readonly agentIndex: number) {}
  check(_model: Readonly<Model>): boolean {
    return true;
  }
  run(_model: Model, real: Real): void {
    const known = [...real.knownAgents];
    if (known.length === 0) return;
    const agentId = known[this.agentIndex % known.length] as AgentId;
    real.pool.markLoginRequired(agentId);
    real.busyAssignment.delete(agentId);
    assertInvariant(real);
  }
  toString(): string {
    return `LoginRequired(idx=${this.agentIndex})`;
  }
}

class LoginRecoveredCmd implements fc.Command<Model, Real> {
  constructor(readonly agentIndex: number) {}
  check(_model: Readonly<Model>): boolean {
    return true;
  }
  run(_model: Model, real: Real): void {
    const known = [...real.knownAgents];
    if (known.length === 0) return;
    const agentId = known[this.agentIndex % known.length] as AgentId;
    // markReady throws if already idle; only call when login_required.
    const idleSet = new Set<AgentId>(real.pool.idle().map((s) => s.agentId));
    const busySet = new Set<AgentId>(real.pool.busy().map((b) => b.agent.agentId));
    if (idleSet.has(agentId) || busySet.has(agentId)) return;
    real.pool.markReady(agentId);
    real.busyAssignment.delete(agentId);
    assertInvariant(real);
  }
  toString(): string {
    return `LoginRecovered(idx=${this.agentIndex})`;
  }
}

// ─── arbitraries ───────────────────────────────────────────────────────────

const registerArb: fc.Arbitrary<fc.Command<Model, Real>> = fc
  .uuid()
  .map((id) => new RegisterAgentCmd(`agent-${id}`));

const disconnectArb: fc.Arbitrary<fc.Command<Model, Real>> = fc
  .integer({ min: 0, max: 9 })
  .map((idx) => new DisconnectAgentCmd(idx));

const dispatchArb: fc.Arbitrary<fc.Command<Model, Real>> = fc
  .integer({ min: 0, max: 9 })
  .map((idx) => new DispatchCmd(idx));

const completeArb: fc.Arbitrary<fc.Command<Model, Real>> = fc
  .integer({ min: 0, max: 9 })
  .map((idx) => new AgentChunkFinalCmd(idx));

const loginRequiredArb: fc.Arbitrary<fc.Command<Model, Real>> = fc
  .integer({ min: 0, max: 9 })
  .map((idx) => new LoginRequiredCmd(idx));

const loginRecoveredArb: fc.Arbitrary<fc.Command<Model, Real>> = fc
  .integer({ min: 0, max: 9 })
  .map((idx) => new LoginRecoveredCmd(idx));

// ─── test ──────────────────────────────────────────────────────────────────

describe('agentPool — Property 3: state consistency', () => {
  it('|busy| + |idle| + |loginRequired| == |registered| and disjointness holds after every action', () => {
    fc.assert(
      fc.property(
        fc.commands(
          [registerArb, disconnectArb, dispatchArb, completeArb, loginRequiredArb, loginRecoveredArb],
          { size: '+1' },
        ),
        (cmds) => {
          const pool = new AgentPool();
          const real: Real = {
            pool,
            knownAgents: new Set(),
            disconnected: new Set(),
            busyAssignment: new Map(),
            nextRequestId: 0,
          };
          try {
            // Invariant must hold even on the empty pool.
            assertInvariant(real);
            fc.modelRun(() => ({ model: { registeredCount: 0 }, real }), [...cmds]);
            // Final invariant check.
            assertInvariant(real);
          } finally {
            pool.dispose();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
