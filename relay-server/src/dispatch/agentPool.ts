/**
 * Agent pool — single source of truth for which browser-agents are
 * connected, and in which lifecycle state. Owns the four bookkeeping
 * categories described in the design's "Components and Interfaces ›
 * `dispatch/agentPool.ts`" section: `idle`, `busy`, `login_required`,
 * and the transient `disconnected` set.
 *
 * The pool is a pure-state container. The dispatcher (task 7.1) is the
 * only legitimate writer; all other modules read snapshots via
 * {@link AgentPool.idle}, {@link AgentPool.busy}, and {@link AgentPool.get}.
 *
 * The 1 Hz heartbeat watcher implements R3.3: any registered agent whose
 * last-received heartbeat is older than 45 s is removed from the pool and
 * an `agent_disconnected` event is emitted so the dispatcher can
 * redispatch any in-flight request that was assigned to it. The watcher
 * timer is `.unref()`'d so it never pins the Node event loop.
 *
 * The "disconnected" category from the design is intentionally
 * **transient**: when a heartbeat times out (or {@link AgentPool.disconnect}
 * is called explicitly by the socket-disconnect handler), the agent is
 * fully removed from the pool's internal maps and an event is emitted.
 * Persisting a long-lived "disconnected" set would only duplicate the
 * authoritative state already kept by the Socket.IO transport.
 *
 * Implements R3.1 (registration → idle), R3.2 / R3.3 (heartbeat receipt
 * and 45 s timeout eviction), R3.5 (a fresh `agentId` is the caller's
 * responsibility — we just refuse duplicate registrations), R3.6
 * (malformed heartbeats are discarded — caller validates the schema
 * first; `onHeartbeat` for an unknown agent is a no-op),
 * R23.2 (login_required marks the agent unavailable for dispatch).
 */

import { EventEmitter } from 'node:events';
import type { AgentId } from '@kiro-gpt-bridge/shared';
import type { LeastBusyAgent } from './leastBusy.js';

/**
 * Per-agent runtime state. Structurally extends {@link LeastBusyAgent} so
 * an `AgentState` can be passed straight to `pickIdleAgent` without a
 * shape adapter.
 *
 * `recentDispatches` is mutated in place by `markBusy` (append) and by
 * `pickIdleAgent` (prune to the trailing 60 s window per R5.2).
 *
 * Implements R3.1, R5.2.
 */
export interface AgentState extends LeastBusyAgent {
  /** Server-issued agent identifier. Stable for this registration. */
  readonly agentId: AgentId;
  /** Socket.IO socket id of the connected agent. Stable for the connection lifetime. */
  readonly socketId: string;
  /** Epoch ms when this {@link AgentState} was created. */
  readonly registeredAt: number;
  /** Last received-heartbeat epoch ms. Updated by {@link AgentPool.onHeartbeat}. R3.2. */
  lastHeartbeatAt: number;
  /** Timestamps (ms) of recent dispatches; pruned by leastBusy. R5.2. */
  recentDispatches: number[];
  /** Last terminal-completion ms timestamp; null until the first completion. */
  lastCompletionAt: number | null;
}

/**
 * Bookkeeping for a single in-flight request held by a busy agent. The
 * `requestId` lets the dispatcher redispatch when the agent is lost; the
 * `dispatchedAt` lets the dispatcher enforce the 5 s ack timeout (R5.4).
 */
export interface BusyEntry {
  /** The request currently dispatched to this agent. */
  readonly requestId: string;
  /** Epoch ms when {@link AgentPool.markBusy} was called. */
  readonly dispatchedAt: number;
}

/** Lifecycle category for a registered agent. */
type AgentCategory = 'idle' | 'busy' | 'login_required';

/**
 * Strongly-typed Socket.IO-style event map for the {@link AgentPool}'s
 * `EventEmitter` surface. Currently only `agent_disconnected` is emitted;
 * future events should be added here so consumers stay type-checked.
 */
export interface PoolEvents {
  /**
   * Emitted when an agent is removed from the pool — either because its
   * heartbeat exceeded 45 s without an update (R3.3) or because the
   * socket-layer called {@link AgentPool.disconnect} explicitly. The
   * agent is no longer in any internal map by the time the event fires.
   */
  agent_disconnected: (agentId: AgentId) => void;
}

/**
 * Options accepted by the {@link AgentPool} constructor.
 */
export interface AgentPoolOptions {
  /** Heartbeat-timeout ms. Default 45_000 (R3.3). */
  heartbeatTimeoutMs?: number;
  /** Watcher tick ms. Default 1_000. */
  tickMs?: number;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Owns the four bookkeeping sets (idle / busy / login_required /
 * disconnected), runs a 1 Hz heartbeat watcher, and emits
 * `agent_disconnected` when an agent's heartbeat exceeds 45 s without an
 * update.
 *
 * Implements R3.1, R3.2, R3.3, R3.5, R3.6, R23.2.
 */
export class AgentPool extends EventEmitter {
  /** Single map of every registered agent (idle ∪ busy ∪ login_required). */
  readonly #agents: Map<AgentId, AgentState> = new Map();
  /** Lifecycle category, kept in lock-step with `#agents`. */
  readonly #status: Map<AgentId, AgentCategory> = new Map();
  /** Per-busy-agent in-flight request bookkeeping. */
  readonly #busyEntries: Map<AgentId, BusyEntry> = new Map();

  /** Configured heartbeat timeout in ms (R3.3). */
  readonly #heartbeatTimeoutMs: number;
  /** Configured watcher tick in ms. */
  readonly #tickMs: number;
  /** Clock function — injected for tests. */
  readonly #now: () => number;
  /** Watcher timer; `null` after {@link AgentPool.dispose}. */
  #timer: NodeJS.Timeout | null;

  /**
   * @param opts See {@link AgentPoolOptions}. All fields are optional.
   */
  constructor(opts: AgentPoolOptions = {}) {
    super();
    this.#heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 45_000;
    this.#tickMs = opts.tickMs ?? 1_000;
    this.#now = opts.now ?? Date.now;

    this.#timer = setInterval(() => this.#tick(), this.#tickMs);
    // Don't pin the event loop — tests and production both expect Node
    // to exit cleanly on SIGTERM without waiting for this watcher.
    this.#timer.unref();
  }

  /**
   * Register a fresh agent in the idle pool.
   *
   * The caller is responsible for issuing a unique `agentId` per
   * (re)connection (R3.5); the pool refuses duplicates with a thrown
   * `Error` so the caller is forced to call {@link AgentPool.disconnect}
   * first if they intend to recycle an id (which they shouldn't).
   *
   * Implements R3.1, R3.5.
   */
  register(agentId: AgentId, socketId: string): AgentState {
    if (this.#agents.has(agentId)) {
      throw new Error(`AgentPool.register: duplicate agentId ${agentId}`);
    }
    const now = this.#now();
    const state: AgentState = {
      agentId,
      socketId,
      registeredAt: now,
      lastHeartbeatAt: now,
      recentDispatches: [],
      lastCompletionAt: null,
    };
    this.#agents.set(agentId, state);
    this.#status.set(agentId, 'idle');
    return state;
  }

  /**
   * Move an idle agent to busy on a given request. Appends the current
   * timestamp to the agent's `recentDispatches` window so the next
   * least-busy selection sees it.
   *
   * Throws when the agent is unknown or not currently idle — the
   * dispatcher must guarantee both invariants before calling.
   *
   * Implements R5.2 (sliding-window workload metric is updated here),
   * R7.4 (one-request-per-agent invariant is enforced by the
   * idle-precondition).
   */
  markBusy(agentId: AgentId, requestId: string): void {
    const status = this.#status.get(agentId);
    if (status === undefined) {
      throw new Error(`AgentPool.markBusy: unknown agentId ${agentId}`);
    }
    if (status !== 'idle') {
      throw new Error(
        `AgentPool.markBusy: agent ${agentId} is ${status}, expected idle`,
      );
    }
    const state = this.#agents.get(agentId);
    if (state === undefined) {
      // Defensive: should be impossible because `#status` and `#agents`
      // are always written together. Throw rather than silently swallow.
      throw new Error(`AgentPool.markBusy: agent ${agentId} missing state`);
    }
    const now = this.#now();
    state.recentDispatches.push(now);
    this.#status.set(agentId, 'busy');
    this.#busyEntries.set(agentId, { requestId, dispatchedAt: now });
  }

  /**
   * Move an agent to idle. Callable from `busy` (request just completed)
   * or from `login_required` (rare: the agent recovered without further
   * signalling). When the source state is `busy` the agent's
   * `lastCompletionAt` is set to `now()` so the round-robin tie-break
   * in the least-busy selector treats this agent as the most-recently-
   * completed (R5.2). A `login_required → idle` transition does NOT
   * count as a "completion" so `lastCompletionAt` is left unchanged.
   *
   * Throws when the agent is unknown or already idle.
   *
   * Implements R5.2 (lastCompletionAt update on completion), R23.2
   * (recovery path from login_required).
   */
  markIdle(agentId: AgentId): void {
    const status = this.#status.get(agentId);
    if (status === undefined) {
      throw new Error(`AgentPool.markIdle: unknown agentId ${agentId}`);
    }
    if (status === 'idle') {
      throw new Error(`AgentPool.markIdle: agent ${agentId} is already idle`);
    }
    const state = this.#agents.get(agentId);
    if (state === undefined) {
      throw new Error(`AgentPool.markIdle: agent ${agentId} missing state`);
    }
    if (status === 'busy') {
      state.lastCompletionAt = this.#now();
      this.#busyEntries.delete(agentId);
    }
    // login_required → idle: do NOT update lastCompletionAt; the agent
    // never produced a terminal chunk, it simply recovered auth.
    this.#status.set(agentId, 'idle');
  }

  /**
   * Move an agent to `login_required`. From `idle` this is a clean swap;
   * from `busy` the in-flight {@link BusyEntry} is dropped — the
   * dispatcher observes the agent leaving the busy pool and is expected
   * to redispatch the request to another idle agent (R5.7, R7.8).
   *
   * No-op when the agent is already `login_required`. Throws when the
   * agent is unknown.
   *
   * Implements R23.2 (mark-unavailable when ChatGPT requires login).
   */
  markLoginRequired(agentId: AgentId): void {
    const status = this.#status.get(agentId);
    if (status === undefined) {
      throw new Error(
        `AgentPool.markLoginRequired: unknown agentId ${agentId}`,
      );
    }
    if (status === 'login_required') return;
    if (status === 'busy') {
      this.#busyEntries.delete(agentId);
    }
    this.#status.set(agentId, 'login_required');
  }

  /**
   * Move an agent into the idle pool from `login_required` (the canonical
   * case — the user finished logging in to ChatGPT) or, rarely, from
   * `busy` (the agent recovered without producing a terminal chunk). In
   * neither case is this treated as a "completion", so
   * `lastCompletionAt` is left untouched. The {@link BusyEntry} is
   * cleared on a `busy → idle` transition so the dispatcher's
   * one-request-per-agent invariant holds.
   *
   * Throws when the agent is unknown or already idle.
   *
   * Implements R23.2 (recovery path), R3.5 (agent rejoining the dispatch
   * pool after auth pause).
   */
  markReady(agentId: AgentId): void {
    const status = this.#status.get(agentId);
    if (status === undefined) {
      throw new Error(`AgentPool.markReady: unknown agentId ${agentId}`);
    }
    if (status === 'idle') {
      throw new Error(`AgentPool.markReady: agent ${agentId} is already idle`);
    }
    if (status === 'busy') {
      this.#busyEntries.delete(agentId);
    }
    this.#status.set(agentId, 'idle');
  }

  /**
   * Drop an agent entirely. Used by the heartbeat watcher (R3.3) and by
   * the socket-disconnect handler. Returns the {@link BusyEntry} the
   * agent was holding (so the caller can redispatch the request) or
   * `null` when the agent was idle / login_required / unknown.
   *
   * Emits `agent_disconnected` synchronously when the agent was known.
   * No event is emitted for an unknown agent so repeated calls from the
   * socket and watcher layers are idempotent.
   *
   * Implements R3.3 (heartbeat-miss eviction), R7.8 (in-flight request
   * is surfaced for redispatch).
   */
  disconnect(agentId: AgentId): BusyEntry | null {
    if (!this.#agents.has(agentId)) {
      return null;
    }
    const entry = this.#busyEntries.get(agentId) ?? null;
    this.#agents.delete(agentId);
    this.#status.delete(agentId);
    this.#busyEntries.delete(agentId);
    this.emit('agent_disconnected', agentId);
    return entry;
  }

  /**
   * Update `lastHeartbeatAt` for the given agent to the current clock
   * value. No-op when the agent is unknown — the caller (the agent
   * socket handler) is responsible for validating the heartbeat schema
   * first per R3.6, so an unknown id here means either a race with
   * disconnect or a malformed agentId; either way the safest action is
   * to silently drop the update.
   *
   * Implements R3.2, R3.6.
   */
  onHeartbeat(agentId: AgentId): void {
    const state = this.#agents.get(agentId);
    if (state === undefined) return;
    state.lastHeartbeatAt = this.#now();
  }

  /**
   * Snapshot of currently-idle agents — a fresh array, safe to sort or
   * filter without mutating pool state. The selector at
   * {@link LeastBusyAgent} consumes this directly.
   *
   * Implements R5.2 (input shape for `pickIdleAgent`).
   */
  idle(): AgentState[] {
    const out: AgentState[] = [];
    for (const state of this.#agents.values()) {
      if (this.#status.get(state.agentId) === 'idle') {
        out.push(state);
      }
    }
    return out;
  }

  /**
   * Snapshot of currently-busy agents paired with their {@link BusyEntry}.
   * Used by the dispatcher's redispatch path and by `/health` when
   * computing in-flight counts.
   */
  busy(): Array<{ agent: AgentState; entry: BusyEntry }> {
    const out: Array<{ agent: AgentState; entry: BusyEntry }> = [];
    for (const state of this.#agents.values()) {
      if (this.#status.get(state.agentId) !== 'busy') continue;
      const entry = this.#busyEntries.get(state.agentId);
      if (entry === undefined) continue; // defensive; should be impossible
      out.push({ agent: state, entry });
    }
    return out;
  }

  /**
   * Total count of agents currently available to dispatch — i.e. agents
   * in `idle` or `busy`. Excludes `login_required` (R23.2 marks them
   * unavailable) and disconnected agents (already removed from the
   * pool by `disconnect`).
   *
   * Used by `/health` (R1.7) and the metrics gauge (R24.5).
   */
  registeredCount(): number {
    let count = 0;
    for (const status of this.#status.values()) {
      if (status === 'idle' || status === 'busy') count += 1;
    }
    return count;
  }

  /**
   * Look up the {@link AgentState} for any registered agent (idle, busy,
   * or login_required). Returns `undefined` when the agent is not in the
   * pool. Disconnected agents are no longer registered and therefore
   * always return `undefined`.
   */
  get(agentId: AgentId): AgentState | undefined {
    return this.#agents.get(agentId);
  }

  /**
   * Stop the heartbeat watcher. Idempotent: subsequent calls are
   * no-ops. After dispose, mutating methods still work but no automatic
   * heartbeat eviction occurs — this is by design so tests can fully
   * control timing.
   */
  dispose(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Heartbeat watcher tick. Walks every registered agent and disconnects
   * any whose `lastHeartbeatAt` is older than the configured timeout.
   *
   * The collection step runs first so we don't mutate `#agents` while
   * iterating it.
   *
   * Implements R3.3.
   */
  #tick(): void {
    const now = this.#now();
    const cutoff = now - this.#heartbeatTimeoutMs;
    const stale: AgentId[] = [];
    for (const state of this.#agents.values()) {
      if (state.lastHeartbeatAt < cutoff) {
        stale.push(state.agentId);
      }
    }
    for (const agentId of stale) {
      this.disconnect(agentId);
    }
  }
}
