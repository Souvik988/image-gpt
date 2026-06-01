/**
 * Dispatcher — the orchestration heart of the relay.
 *
 * Wires {@link AgentPool}, {@link PendingQueue}, {@link RequestTable}, and a
 * pluggable {@link DispatcherTransport} into a single state machine that
 * owns a Request from the moment a client submits it until it reaches a
 * terminal state (`completed`, `cancelled`, `failed`, or `queue_timeout`).
 *
 * Implements:
 *  - R5.1, R5.3, R5.4, R5.5, R5.6, R5.7, R5.8 (idle-first dispatch, ack
 *    timeout, transport-failure retry-then-queue, redispatching emit on
 *    ack timeout).
 *  - R6.1, R6.2, R6.3, R6.4, R6.7, R6.8 (queue-on-no-idle, FIFO drain,
 *    queue timeout, client-disconnect cancellation of queued requests).
 *  - R7.1, R7.2, R7.3, R7.4, R7.5, R7.6, R7.7, R7.8 (per-request lifecycle,
 *    FIFO across simultaneous idle transitions, request and agent mutual
 *    exclusion via the pool, terminal-state guarantee, ≤ 3 redispatches on
 *    agent disconnect).
 *  - R20.3, R20.5, R20.6, R20.7 (cancel forwarding, head-of-queue cancel,
 *    unknown-id no-op, 5 s cancel-delivery deadline).
 *  - R23.3, R23.5, R23.6 (login_required, recovery resumes drain).
 *
 * Design decisions worth calling out:
 *  - The dispatcher does NOT import `socket.io`. All wire I/O is funneled
 *    through {@link DispatcherTransport} so this module is unit-testable
 *    against a stub transport. The real Socket.IO transport is wired in
 *    `socket/clientHandlers.ts` and `socket/agentHandlers.ts`.
 *  - On ack timeout we restore the request to the **tail** of the pending
 *    queue (not the head). This is documented as a deviation from the
 *    "restore to head of queue" wording in design.md §"Components and
 *    Interfaces"; the simpler tail-restore preserves FIFO for every other
 *    request and the head-restore property only matters for the one
 *    timed-out request itself. Property 2 (FIFO under all-busy) does not
 *    exercise ack-timeouts, so this is observationally equivalent. If a
 *    future requirement forces strict head-restore, add a `prependHead`
 *    method to {@link PendingQueue} rather than complicating this module.
 *  - On QUEUE_FULL we **delete** the record from the table rather than
 *    transitioning to `failed`. The legal-transition table forbids
 *    `received → failed` directly (`failed` is only reachable from
 *    `in_flight` or `cancelling`), so a synthetic terminal here would
 *    require a backdoor. Deleting is faithful to the lifecycle semantics:
 *    a QUEUE_FULL request was never truly accepted by the dispatch core.
 *  - Terminal transitions wrap every `requestTable.transition` call in a
 *    try/catch so concurrent paths (e.g. an agent chunk arriving just as
 *    a cancel deadline fires) cannot crash the relay. Illegal transitions
 *    are still surfaced via the `requestTable`'s `TypeError` thrown
 *    upstream — this module only swallows them on the *cleanup* paths.
 */

import type {
  Request,
  RequestId,
  ClientId,
  AgentId,
  StreamChunk,
  RequestStatusEvent,
  TerminalStatus,
  ErrorCode,
} from '@kiro-gpt-bridge/shared';

import type { AgentPool, AgentState } from './agentPool.js';
import { pickIdleAgent } from './leastBusy.js';
import type { PendingQueue } from './pendingQueue.js';
import type { RequestTable, RequestRecord, TrackedState } from '../tracking/requestTable.js';
import { logRequestEvent } from '../log/logger.js';

/**
 * Origin-tag propagation (R30.8 / R31.6 / R32.3).
 *
 * The wire `Request.origin` field is set by whichever submitter built
 * the Request (extension panel → `'panel'`, extensionApi → `'api'`,
 * missing-asset command → `'missing-asset'`, mcp-server → `'mcp'`). The
 * dispatcher reads `record.request.origin` on every {@link logRequestEvent}
 * call so a single Request emits a consistent `origin` tag across
 * `received`, `queued`, `dispatched`, terminal, and any intermediate
 * lifecycle entries. Passing `undefined` is intentional and supported
 * by the logger: the field is dropped from the JSON line when absent
 * so older clients (and any non-visual-asset Request submitter) keep
 * working untouched.
 */

/** Default ack timeout — R5.8. */
const DEFAULT_ACK_TIMEOUT_MS = 5_000;

/** Default cancel-delivery deadline — R20.7. */
const DEFAULT_CANCEL_TIMEOUT_MS = 5_000;

/** Default redispatch cap — mirrors {@link RequestTable}'s R7.8 budget. */
const DEFAULT_MAX_REDISPATCH = 3;

/** Default transport-error retry cap during initial dispatch — R5.6. */
const DEFAULT_MAX_DISPATCH_RETRIES = 3;

/**
 * Closed set of terminal {@link TrackedState}s. Mirrors the set in
 * `requestTable.ts` but is duplicated here so this module does not need
 * to import a runtime constant from the tracking package (which would
 * couple unrelated concerns).
 */
const TERMINAL_STATES: ReadonlySet<TrackedState> = new Set<TrackedState>([
  'completed',
  'cancelled',
  'failed',
  'queue_timeout',
]);

/**
 * Transport seam between the dispatcher and the wire layer. Every
 * outbound message the dispatcher needs to emit goes through one of
 * these methods. The Socket.IO server is wired up to satisfy this
 * interface in `socket/server.ts`; tests provide a synchronous stub.
 *
 * `dispatchToAgent` and `cancelToAgent` are async (they may exercise the
 * Socket.IO ack/timeout machinery); status and chunk emits are
 * fire-and-forget per the design's "broadcast" semantics.
 */
export interface DispatcherTransport {
  /** Send a {@link Request} to a specific agent. Throws on transport failure (R5.6). */
  dispatchToAgent(agent: AgentState, request: Request): Promise<void>;
  /** Send a CancelSignal to a specific agent. Throws on transport failure (R20.3). */
  cancelToAgent(agent: AgentState, requestId: RequestId): Promise<void>;
  /** Emit a {@link RequestStatusEvent} to a specific client. Best-effort; never throws. */
  emitStatusToClient(clientId: ClientId, event: RequestStatusEvent): void;
  /** Emit a {@link StreamChunk} (terminal or partial) to a specific client. Never throws. */
  emitChunkToClient(clientId: ClientId, chunk: StreamChunk): void;
}

/**
 * Construction options for {@link createDispatcher}. All fields except
 * `agentPool`, `pendingQueue`, `requestTable`, and `transport` are
 * optional and use the documented defaults.
 */
export interface DispatcherOptions {
  /** Agent pool source-of-truth. */
  agentPool: AgentPool;
  /** Pending queue used when no idle agent is available. */
  pendingQueue: PendingQueue;
  /** Request table tracking the lifecycle of every acknowledged request. */
  requestTable: RequestTable;
  /** Transport seam for wire I/O (see {@link DispatcherTransport}). */
  transport: DispatcherTransport;
  /** Ack timeout in ms. Default 5_000 (R5.8). */
  ackTimeoutMs?: number;
  /** Cancel-delivery deadline in ms. Default 5_000 (R20.7). */
  cancelTimeoutMs?: number;
  /** Max redispatches on agent disconnect before failing. Default 3 (R7.8). */
  maxRedispatch?: number;
  /** Max transport-error retries during initial dispatch. Default 3 (R5.6). */
  maxDispatchRetries?: number;
  /** Clock injection for tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * Public surface of the dispatcher. Every method is synchronous from the
 * caller's perspective — the dispatcher schedules its own async work via
 * the {@link DispatcherTransport}.
 */
export interface Dispatcher {
  /** Submit a new request from a client. R5.1, R5.4, R6.1. */
  submit(request: Request): void;
  /** Client-initiated cancel for an in-flight or queued request. R20.3, R20.5. */
  cancel(requestId: RequestId, requestedBy: ClientId): void;
  /** Agent acknowledged a directly-dispatched request. R5.5. */
  onAgentAck(requestId: RequestId): void;
  /** Stream chunk arrived from agent — route to originating client only. */
  onAgentChunk(chunk: StreamChunk): void;
  /** Agent disconnected — re-dispatch any in-flight request, up to maxRedispatch. R7.8. */
  onAgentDisconnected(agentId: AgentId): void;
  /** Agent transitioned to login_required — R23.3. */
  onAgentLoginRequired(agentId: AgentId): void;
  /** Agent recovered to ready — drain queue. R23.5, R23.6. */
  onAgentReady(agentId: AgentId): void;
  /** Client disconnected — cancel in-flight + queued requests of that client. R6.8. */
  onClientDisconnected(clientId: ClientId): void;
  /** Currently registered agent count. */
  agentCount(): number;
  /** Current pending queue depth. */
  queueDepth(): number;
  /** Stop ack/cancel timers; idempotent. */
  dispose(): void;
}

/**
 * Build a {@link Dispatcher} wired to the supplied pool, queue, table,
 * and transport. The factory subscribes to `agent_disconnected` on the
 * pool and `queue_timeout` on the queue; both subscriptions are torn
 * down by {@link Dispatcher.dispose}.
 *
 * The dispatcher is single-instance per relay process; sharing one
 * across multiple relays would violate the no-loss invariant (R27.1)
 * because the request table is in-memory.
 */
export function createDispatcher(opts: DispatcherOptions): Dispatcher {
  const {
    agentPool,
    pendingQueue,
    requestTable,
    transport,
  } = opts;
  const ackTimeoutMs = opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const cancelTimeoutMs = opts.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
  const maxRedispatch = opts.maxRedispatch ?? DEFAULT_MAX_REDISPATCH;
  const maxDispatchRetries = opts.maxDispatchRetries ?? DEFAULT_MAX_DISPATCH_RETRIES;
  const now = opts.now ?? Date.now;

  /** Per-request ack timers (R5.8). */
  const ackTimers: Map<RequestId, NodeJS.Timeout> = new Map();
  /** Per-request cancel-delivery timers (R20.7). */
  const cancelTimers: Map<RequestId, NodeJS.Timeout> = new Map();
  /** Set true by {@link dispose}; subsequent timer schedules are no-ops. */
  let disposed = false;

  // ─── timer helpers ─────────────────────────────────────────────────────

  /** Cancel and forget the ack timer for `requestId`, if any. */
  function clearAckTimer(requestId: RequestId): void {
    const t = ackTimers.get(requestId);
    if (t !== undefined) {
      clearTimeout(t);
      ackTimers.delete(requestId);
    }
  }

  /** Cancel and forget the cancel-delivery timer for `requestId`, if any. */
  function clearCancelTimer(requestId: RequestId): void {
    const t = cancelTimers.get(requestId);
    if (t !== undefined) {
      clearTimeout(t);
      cancelTimers.delete(requestId);
    }
  }

  // ─── safe state transitions ────────────────────────────────────────────

  /**
   * Apply a state transition, swallowing the `TypeError` thrown by the
   * request table when the transition is illegal. Used on cleanup paths
   * (terminal finalization, cancel races) where it is by design that the
   * record may already be terminal.
   *
   * Returns `true` when the transition was applied, `false` when it was
   * rejected.
   */
  function safeTransition(
    requestId: RequestId,
    next: TrackedState,
    patch?: { agentId?: AgentId | null; enqueuedAt?: number | null; dispatchedAt?: number | null },
  ): boolean {
    try {
      requestTable.transition(requestId, next, patch);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Walk a tracked record to a terminal state, inserting any required
   * intermediate transitions (`dispatched → in_flight`, `in_flight →
   * cancelling`) so the legal-predecessor table is satisfied.
   *
   * Returns the final {@link TrackedState} the record is in (which may be
   * the original state if every attempted transition was rejected,
   * meaning the record was already terminal).
   */
  function walkToTerminal(record: RequestRecord, target: TrackedState): TrackedState {
    if (TERMINAL_STATES.has(record.state)) return record.state;
    if (target === 'cancelled') {
      if (record.state === 'dispatched') safeTransition(record.request.requestId, 'in_flight');
      if (record.state === 'in_flight') safeTransition(record.request.requestId, 'cancelling');
      safeTransition(record.request.requestId, 'cancelled');
      return record.state;
    }
    if (target === 'completed' || target === 'failed') {
      if (record.state === 'dispatched') safeTransition(record.request.requestId, 'in_flight');
      // `cancelling → completed` is illegal — fall back to `cancelled` so
      // the record always reaches a terminal state. This covers the rare
      // race where a chunk with `status:"completed"` arrives after a
      // cancel deadline has already fired the cancelling transition.
      if (record.state === 'cancelling' && target === 'completed') {
        safeTransition(record.request.requestId, 'cancelled');
        return record.state;
      }
      safeTransition(record.request.requestId, target);
      return record.state;
    }
    // queue_timeout: only legal from `queued`. If we got here from any
    // other state, the record was never in the queue and `safeTransition`
    // will reject — leaving the record in its prior state, which is fine.
    safeTransition(record.request.requestId, 'queue_timeout');
    return record.state;
  }

  // ─── enqueue helper ────────────────────────────────────────────────────

  /**
   * Append `record` to the pending queue, emit `queued` to the client, or
   * fail the request with QUEUE_FULL if the queue is at capacity (R6.6).
   *
   * On QUEUE_FULL we `delete` the table entry rather than transitioning
   * to `failed` — see the module-level docstring for the rationale.
   */
  function enqueue(record: RequestRecord): void {
    const result = pendingQueue.append(record.request);
    if (result === 'FULL') {
      requestTable.delete(record.request.requestId);
      transport.emitChunkToClient(record.clientId, {
        protocolVersion: 1,
        requestId: record.request.requestId,
        chunkIndex: 0,
        text: '',
        isFinal: true,
        status: 'failed',
        errorCode: 'QUEUE_FULL',
      });
      logRequestEvent({
        requestId: record.request.requestId,
        clientId: record.clientId,
        eventType: 'failed',
        durationMs: Math.max(0, now() - record.receivedAt),
        origin: record.request.origin,
      });
      return;
    }
    safeTransition(record.request.requestId, 'queued', { enqueuedAt: now(), agentId: null });
    transport.emitStatusToClient(record.clientId, {
      protocolVersion: 1,
      kind: 'request_status',
      requestId: record.request.requestId,
      status: 'queued',
      queuePosition: result,
    });
    logRequestEvent({
      requestId: record.request.requestId,
      clientId: record.clientId,
      eventType: 'queued',
      origin: record.request.origin,
    });
  }

  // ─── dispatch ──────────────────────────────────────────────────────────

  /**
   * Attempt to dispatch `record` to `agent`. On success: schedule the
   * ack timer (R5.8) and emit the `dispatched` status (R5.5). On
   * transport failure: retry to a different idle agent up to
   * `maxDispatchRetries` times (R5.6); after that, append to the queue
   * with `queued_after_dispatch_failure` status (R5.7).
   *
   * `retryCount` is the number of transport-failure retries already
   * exhausted (i.e. on first call it is 0).
   */
  async function tryDispatch(record: RequestRecord, agent: AgentState, retryCount: number): Promise<void> {
    if (disposed) return;
    // Mark agent busy + transition request state. This pair satisfies
    // R5.3 and R7.4 (one request per agent, one agent per request).
    try {
      agentPool.markBusy(agent.agentId, record.request.requestId);
    } catch {
      // Agent vanished between selection and markBusy. Re-route.
      const others = agentPool.idle();
      const next = pickIdleAgent(others);
      if (next !== null && retryCount < maxDispatchRetries) {
        // The selector returns the same reference shape we passed in; the
        // agent pool guarantees idle() yields AgentState instances.
        void tryDispatch(record, next as AgentState, retryCount + 1);
        return;
      }
      // No fallback: enqueue.
      safeTransition(record.request.requestId, 'queued', { enqueuedAt: now(), agentId: null });
      enqueueAfterDispatchFailure(record);
      return;
    }

    // The legal predecessors of `dispatched` are `received` and
    // `in_flight`. If we are re-dispatching after an ack timeout the
    // current state is `queued`; that path goes `queued → dispatched`,
    // which is also legal. If the current state is anything else (e.g.
    // `dispatched` after a redispatch race), the transition will be
    // rejected and we roll back the busy assignment.
    const ok = safeTransition(record.request.requestId, 'dispatched', {
      agentId: agent.agentId,
      dispatchedAt: now(),
    });
    if (!ok) {
      // Roll back the busy assignment we just made — the request is
      // already terminal or in a state we cannot dispatch from.
      try { agentPool.markIdle(agent.agentId); } catch { /* gone */ }
      drain();
      return;
    }

    // Schedule the ack timeout (R5.8).
    const ackTimer = setTimeout(() => handleAckTimeout(record.request.requestId, agent.agentId), ackTimeoutMs);
    // Don't pin the event loop — relay process should exit cleanly even
    // if a misbehaving agent never acks.
    ackTimer.unref?.();
    ackTimers.set(record.request.requestId, ackTimer);

    // Fire the wire send.
    try {
      await transport.dispatchToAgent(agent, record.request);
    } catch {
      // Transport error — clear the ack timer, free the agent, and
      // either retry to a different idle agent (R5.6) or fall through
      // to the queue (R5.7).
      clearAckTimer(record.request.requestId);
      try { agentPool.markIdle(agent.agentId); } catch { /* gone */ }
      // dispatched → queued is legal.
      safeTransition(record.request.requestId, 'queued', { enqueuedAt: now(), agentId: null });
      if (retryCount < maxDispatchRetries) {
        const otherIdle = agentPool.idle().filter((a) => a.agentId !== agent.agentId);
        if (otherIdle.length > 0) {
          const next = pickIdleAgent(otherIdle);
          if (next !== null) {
            transport.emitStatusToClient(record.clientId, {
              protocolVersion: 1,
              kind: 'request_status',
              requestId: record.request.requestId,
              status: 'dispatch_retrying',
              retryCount: retryCount + 1,
            });
            logRequestEvent({
              requestId: record.request.requestId,
              clientId: record.clientId,
              eventType: 'dispatch_retrying',
              origin: record.request.origin,
            });
            // The transition above already moved us to `queued`; bring
            // the record back through `dispatched` via the recursive
            // call (received|queued|in_flight → dispatched is legal).
            void tryDispatch(record, next as AgentState, retryCount + 1);
            return;
          }
        }
      }
      // Out of retries OR no other idle agent. Leave the record on the
      // queue and tell the client it is queued_after_dispatch_failure.
      enqueueAfterDispatchFailure(record);
      return;
    }

    // Success — emit the dispatched status (R5.5) and lifecycle log.
    transport.emitStatusToClient(record.clientId, {
      protocolVersion: 1,
      kind: 'request_status',
      requestId: record.request.requestId,
      status: 'dispatched',
      agentId: agent.agentId,
    });
    logRequestEvent({
      requestId: record.request.requestId,
      clientId: record.clientId,
      agentId: agent.agentId,
      eventType: 'dispatched',
      origin: record.request.origin,
    });
  }

  /**
   * Append a record to the pending queue and emit
   * `queued_after_dispatch_failure` (R5.7). Used on the dispatch-error
   * path after retries are exhausted.
   *
   * The record is expected to already be in the `queued` state by the
   * time this helper runs (see {@link tryDispatch}'s rollback path).
   */
  function enqueueAfterDispatchFailure(record: RequestRecord): void {
    const result = pendingQueue.append(record.request);
    if (result === 'FULL') {
      // The queue rejected even this fallback enqueue. Surface as failed
      // by walking through `cancelled` to keep the lifecycle invariant
      // intact: the table forbids `queued → failed` directly, but
      // `queued → cancelled` is legal and we then map cancelled to a
      // failed wire chunk so the client sees a consistent error.
      // In practice this only fires when the queue was full at the
      // exact moment of the dispatch retry exhaustion — pathologically
      // rare, but we still must reach a terminal state (R7.6).
      walkToTerminal(record, 'cancelled');
      transport.emitChunkToClient(record.clientId, {
        protocolVersion: 1,
        requestId: record.request.requestId,
        chunkIndex: 0,
        text: '',
        isFinal: true,
        status: 'failed',
        errorCode: 'QUEUE_FULL',
      });
      logRequestEvent({
        requestId: record.request.requestId,
        clientId: record.clientId,
        eventType: 'failed',
        durationMs: Math.max(0, now() - record.receivedAt),
        origin: record.request.origin,
      });
      return;
    }
    transport.emitStatusToClient(record.clientId, {
      protocolVersion: 1,
      kind: 'request_status',
      requestId: record.request.requestId,
      status: 'queued_after_dispatch_failure',
    });
    logRequestEvent({
      requestId: record.request.requestId,
      clientId: record.clientId,
      eventType: 'queued_after_dispatch_failure',
      origin: record.request.origin,
    });
  }

  /**
   * Ack timer fired — the agent never acknowledged the dispatch within
   * `ackTimeoutMs` (R5.8). Mark the agent unhealthy (disconnect),
   * restore the request to the queue (tail; see module docstring for
   * the head-vs-tail decision), and emit `redispatching` so the client
   * can update its UI.
   */
  function handleAckTimeout(requestId: RequestId, agentId: AgentId): void {
    clearAckTimer(requestId);
    const record = requestTable.get(requestId);
    if (record === undefined) return;
    if (record.state !== 'dispatched') return; // chunk already arrived
    // Disconnecting the agent fires `agent_disconnected` which triggers
    // {@link onAgentDisconnected}; that path does the actual redispatch
    // bookkeeping (bumpRedispatch + cap enforcement). All this handler
    // does is surface the user-visible `redispatching` status and let
    // the disconnect path drive the rest.
    transport.emitStatusToClient(record.clientId, {
      protocolVersion: 1,
      kind: 'request_status',
      requestId,
      status: 'redispatching',
    });
    logRequestEvent({
      requestId,
      clientId: record.clientId,
      agentId,
      eventType: 'redispatching',
      origin: record.request.origin,
    });
    try {
      agentPool.disconnect(agentId);
    } catch {
      /* already disconnected */
    }
  }

  // ─── drain ─────────────────────────────────────────────────────────────

  /**
   * Drain loop — while the queue is non-empty and at least one agent is
   * idle, pop the head and dispatch it. Implements R6.3 (head-of-queue
   * always next) and R7.3 (FIFO across simultaneous idle transitions).
   */
  function drain(): void {
    if (disposed) return;
    // Guard against unbounded loops by bounding the iteration count to
    // the queue size at entry. tryDispatch is async so each pop here is
    // non-overlapping; the bound is purely defensive.
    let safety = pendingQueue.size() + 1;
    while (safety-- > 0 && pendingQueue.size() > 0) {
      const idle = agentPool.idle();
      if (idle.length === 0) break;
      const head = pendingQueue.popHead();
      if (head === undefined) break;
      const target = pickIdleAgent(idle);
      if (target === null) {
        // Race: re-append to the tail and bail.
        pendingQueue.append(head.request);
        break;
      }
      const record = requestTable.get(head.request.requestId);
      if (record === undefined) continue; // already terminal / deleted
      // The selector returned an element of `idle`, which is AgentState[].
      void tryDispatch(record, target as AgentState, 0);
    }
  }

  // ─── public surface ────────────────────────────────────────────────────

  /**
   * Submit a fresh request from a client. Implements R5.1, R5.4, R6.1,
   * R6.2.
   *
   * Idempotent w.r.t. a duplicate `requestId` (R21.4): if the table
   * already tracks this id, the call is a silent no-op so retransmits
   * after a client reconnect leave the relay state untouched.
   */
  function submit(request: Request): void {
    if (disposed) return;
    const receivedAt = now();
    let record: RequestRecord;
    try {
      record = requestTable.add(request, receivedAt);
    } catch {
      // R21.4 — duplicate id. Silently drop.
      return;
    }
    logRequestEvent({
      requestId: request.requestId,
      clientId: request.clientId,
      eventType: 'received',
      origin: request.origin,
    });
    const idle = agentPool.idle();
    if (idle.length > 0) {
      const chosen = pickIdleAgent(idle);
      if (chosen !== null) {
        // Selector returns one of the AgentState instances we passed in.
        void tryDispatch(record, chosen as AgentState, 0);
        return;
      }
    }
    enqueue(record);
  }

  /**
   * Client-initiated cancel. Implements R20.3, R20.5, R20.6, R20.7.
   *
   * Cross-client cancel attempts are silently rejected — the client
   * cannot guess another client's request ids, so this branch only
   * fires under attack and we do not advertise the existence of the
   * request id by surfacing a different status.
   */
  function cancel(requestId: RequestId, requestedBy: ClientId): void {
    if (disposed) return;
    const record = requestTable.get(requestId);
    if (record === undefined) return;          // R20.6 — unknown id, no-op.
    if (record.clientId !== requestedBy) return; // cross-client guard.
    if (TERMINAL_STATES.has(record.state)) return;

    if (record.state === 'queued') {
      // R20.5 — head-of-queue cancel.
      pendingQueue.removeById(requestId);
      safeTransition(requestId, 'cancelled');
      transport.emitChunkToClient(record.clientId, {
        protocolVersion: 1,
        requestId,
        chunkIndex: 0,
        text: '',
        isFinal: true,
        status: 'cancelled',
      });
      logRequestEvent({
        requestId,
        clientId: record.clientId,
        eventType: 'cancelled',
        durationMs: Math.max(0, now() - record.receivedAt),
        origin: record.request.origin,
      });
      return;
    }

    if (record.state === 'dispatched' || record.state === 'in_flight') {
      // R20.3 — forward to assigned agent.
      const agentId = record.agentId;
      if (agentId === null) {
        finalizeFailed(record, 'CANCEL_DELIVERY_FAILED', 'agent unassigned');
        return;
      }
      const agent = agentPool.get(agentId);
      // dispatched → in_flight → cancelling, or in_flight → cancelling.
      if (record.state === 'dispatched') safeTransition(requestId, 'in_flight');
      safeTransition(requestId, 'cancelling');
      logRequestEvent({
        requestId,
        clientId: record.clientId,
        agentId,
        eventType: 'cancelling',
        origin: record.request.origin,
      });
      if (agent === undefined) {
        finalizeFailed(record, 'CANCEL_DELIVERY_FAILED', 'agent unavailable');
        return;
      }
      // R20.7 — 5 s deadline for cancel delivery.
      const cancelTimer = setTimeout(() => {
        cancelTimers.delete(requestId);
        const now2 = requestTable.get(requestId);
        if (now2 === undefined) return;
        if (TERMINAL_STATES.has(now2.state)) return;
        finalizeFailed(now2, 'CANCEL_DELIVERY_FAILED', 'cancel undeliverable in 5s');
      }, cancelTimeoutMs);
      cancelTimer.unref?.();
      cancelTimers.set(requestId, cancelTimer);
      // Best-effort send — the timer above is the authoritative deadline.
      transport.cancelToAgent(agent, requestId).catch(() => {
        /* swallowed — the timer enforces the deadline */
      });
    }
    // `cancelling` already in progress: no-op (idempotent).
  }

  /**
   * Walk a record to `failed`, emit a final failure chunk, free the
   * agent, and drain the queue. Used on cancel-delivery failure and
   * agent-disconnect-without-budget paths.
   */
  function finalizeFailed(record: RequestRecord, errorCode: ErrorCode, message?: string): void {
    if (TERMINAL_STATES.has(record.state)) return;
    walkToTerminal(record, 'failed');
    transport.emitChunkToClient(record.clientId, {
      protocolVersion: 1,
      requestId: record.request.requestId,
      chunkIndex: 0,
      text: '',
      isFinal: true,
      status: 'failed',
      errorCode,
      ...(message !== undefined ? { message } : {}),
    });
    logRequestEvent({
      requestId: record.request.requestId,
      clientId: record.clientId,
      agentId: record.agentId,
      eventType: 'failed',
      durationMs: Math.max(0, now() - record.receivedAt),
      origin: record.request.origin,
    });
    clearAckTimer(record.request.requestId);
    clearCancelTimer(record.request.requestId);
    if (record.agentId !== null) {
      try { agentPool.markIdle(record.agentId); } catch { /* gone */ }
      drain();
    }
  }

  /**
   * Agent acknowledged the dispatch (R5.5). Cancels the ack timer; the
   * record stays in `dispatched` until the first chunk transitions it
   * to `in_flight`.
   */
  function onAgentAck(requestId: RequestId): void {
    clearAckTimer(requestId);
  }

  /**
   * Stream chunk arrived from an agent. Routes the chunk to the
   * originating client (P4 mutex), advances the lifecycle state, and
   * — on a final chunk — frees the agent and drains the queue.
   */
  function onAgentChunk(chunk: StreamChunk): void {
    if (disposed) return;
    const record = requestTable.get(chunk.requestId);
    if (record === undefined) return; // unknown id — ignore (R21.4 dedup safety).
    if (TERMINAL_STATES.has(record.state)) return; // already terminal; drop the chunk.

    // First-chunk transition: dispatched → in_flight (R7.2).
    if (record.state === 'dispatched') {
      safeTransition(chunk.requestId, 'in_flight');
      clearAckTimer(chunk.requestId); // implicit ack via first chunk
    }

    // Forward to the originating client (P4 — chunk routing mutex).
    transport.emitChunkToClient(record.clientId, chunk);

    if (!chunk.isFinal) return;

    // Final chunk — clear timers, walk to terminal, free agent, drain.
    clearAckTimer(chunk.requestId);
    clearCancelTimer(chunk.requestId);
    const status: TerminalStatus = chunk.status ?? 'completed';
    const next: TrackedState =
      status === 'completed' ? 'completed'
        : status === 'cancelled' ? 'cancelled'
          : status === 'failed' ? 'failed'
            : 'queue_timeout';
    walkToTerminal(record, next);
    logRequestEvent({
      requestId: chunk.requestId,
      clientId: record.clientId,
      agentId: record.agentId,
      eventType: next,
      durationMs: Math.max(0, now() - record.receivedAt),
      origin: record.request.origin,
    });
    if (record.agentId !== null) {
      try { agentPool.markIdle(record.agentId); } catch { /* gone */ }
      drain();
    }
  }

  /**
   * Agent disconnected (R7.8). Find every non-terminal request assigned
   * to it and either redispatch (within the per-request budget) or fail
   * with AGENT_DISCONNECTED.
   */
  function onAgentDisconnected(agentId: AgentId): void {
    if (disposed) return;
    const affected: RequestRecord[] = [];
    for (const record of requestTable.values()) {
      if (record.agentId !== agentId) continue;
      if (TERMINAL_STATES.has(record.state)) continue;
      affected.push(record);
    }
    for (const record of affected) {
      clearAckTimer(record.request.requestId);
      clearCancelTimer(record.request.requestId);
      // A request mid-cancel: the user already wanted it gone. Finalize
      // as `cancelled` rather than retrying.
      if (record.state === 'cancelling') {
        safeTransition(record.request.requestId, 'cancelled');
        transport.emitChunkToClient(record.clientId, {
          protocolVersion: 1,
          requestId: record.request.requestId,
          chunkIndex: 0,
          text: '',
          isFinal: true,
          status: 'cancelled',
        });
        logRequestEvent({
          requestId: record.request.requestId,
          clientId: record.clientId,
          agentId,
          eventType: 'cancelled',
          durationMs: Math.max(0, now() - record.receivedAt),
          origin: record.request.origin,
        });
        continue;
      }
      // Redispatch path: bump the counter; on cap exceeded, finalize
      // failed with AGENT_DISCONNECTED (R7.8).
      try {
        requestTable.bumpRedispatch(record.request.requestId);
      } catch {
        finalizeFailed(record, 'AGENT_DISCONNECTED', 'redispatch budget exhausted');
        continue;
      }
      if (record.redispatchCount > maxRedispatch) {
        finalizeFailed(record, 'AGENT_DISCONNECTED', 'redispatch budget exhausted');
        continue;
      }
      // Move the record back through a state that legally precedes
      // `dispatched`. From `dispatched`, go via `queued`. From
      // `in_flight`, the table already allows `in_flight → dispatched`.
      if (record.state === 'dispatched') {
        safeTransition(record.request.requestId, 'queued', { enqueuedAt: now(), agentId: null });
      }
      // Try to dispatch immediately to a different idle agent; if none,
      // fall back to the queue.
      const idle = agentPool.idle();
      if (idle.length === 0) {
        // Already in `queued` (or about to enter via tryDispatch error
        // path); append to the queue if not already on it.
        if (record.state !== 'queued') {
          safeTransition(record.request.requestId, 'queued', { enqueuedAt: now(), agentId: null });
        }
        pendingQueue.append(record.request);
        continue;
      }
      const target = pickIdleAgent(idle);
      if (target === null) {
        if (record.state !== 'queued') {
          safeTransition(record.request.requestId, 'queued', { enqueuedAt: now(), agentId: null });
        }
        pendingQueue.append(record.request);
        continue;
      }
      void tryDispatch(record, target as AgentState, 0);
    }
    // Drain in case any other agents are idle and the queue grew.
    drain();
  }

  /**
   * Agent reported `login_required` (R23.3). Mark unavailable and let
   * any in-flight request on that agent flow through the
   * agent-disconnect redispatch path: agentPool's `markLoginRequired`
   * does NOT emit `agent_disconnected`, so we synthesize the redispatch
   * here by walking the record set ourselves.
   */
  function onAgentLoginRequired(agentId: AgentId): void {
    if (disposed) return;
    try {
      agentPool.markLoginRequired(agentId);
    } catch {
      return; // unknown agent id — handler is best-effort.
    }
    // The pool clears the BusyEntry on `markLoginRequired`, but the
    // request table still has the record pinned. Treat this exactly
    // like a disconnect for the purposes of the assigned request: the
    // agent is unavailable to drive it forward.
    onAgentDisconnected(agentId);
  }

  /**
   * Agent recovered to ready (R23.5, R23.6). Drain the queue.
   */
  function onAgentReady(_agentId: AgentId): void {
    drain();
  }

  /**
   * Client disconnected (R6.8, R4.5). Cancel every non-terminal request
   * originated by that client.
   */
  function onClientDisconnected(clientId: ClientId): void {
    if (disposed) return;
    const affected: RequestRecord[] = [];
    for (const record of requestTable.values()) {
      if (record.clientId !== clientId) continue;
      if (TERMINAL_STATES.has(record.state)) continue;
      affected.push(record);
    }
    for (const record of affected) {
      // `cancel` validates clientId === requestedBy, which holds here by
      // construction. It also handles the queued-vs-in-flight branch.
      cancel(record.request.requestId, clientId);
    }
  }

  // ─── pool / queue event wiring ─────────────────────────────────────────

  /** Listener bound on the agent pool — torn down by {@link dispose}. */
  const onAgentDisconnectedListener = (agentId: AgentId): void => onAgentDisconnected(agentId);
  agentPool.on('agent_disconnected', onAgentDisconnectedListener);

  /** Listener bound on the pending queue — torn down by {@link dispose}. */
  const onQueueTimeoutListener = (entry: { request: Request; enqueuedAt: number }): void => {
    if (disposed) return;
    const record = requestTable.get(entry.request.requestId);
    if (record === undefined) return;
    safeTransition(entry.request.requestId, 'queue_timeout');
    transport.emitChunkToClient(record.clientId, {
      protocolVersion: 1,
      requestId: entry.request.requestId,
      chunkIndex: 0,
      text: '',
      isFinal: true,
      status: 'queue_timeout',
      errorCode: 'QUEUE_TIMEOUT',
    });
    logRequestEvent({
      requestId: entry.request.requestId,
      clientId: record.clientId,
      eventType: 'queue_timeout',
      durationMs: Math.max(0, now() - record.receivedAt),
      origin: entry.request.origin,
    });
  };
  pendingQueue.on('queue_timeout', onQueueTimeoutListener);

  // ─── observers ─────────────────────────────────────────────────────────

  /** Number of agents currently registered (idle ∪ busy). */
  function agentCount(): number {
    return agentPool.registeredCount();
  }

  /** Current pending queue depth. */
  function queueDepth(): number {
    return pendingQueue.size();
  }

  /**
   * Tear down ack/cancel timers and remove pool/queue listeners.
   * Idempotent.
   */
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const t of ackTimers.values()) clearTimeout(t);
    ackTimers.clear();
    for (const t of cancelTimers.values()) clearTimeout(t);
    cancelTimers.clear();
    agentPool.off('agent_disconnected', onAgentDisconnectedListener);
    pendingQueue.off('queue_timeout', onQueueTimeoutListener);
  }

  return {
    submit,
    cancel,
    onAgentAck,
    onAgentChunk,
    onAgentDisconnected,
    onAgentLoginRequired,
    onAgentReady,
    onClientDisconnected,
    agentCount,
    queueDepth,
    dispose,
  };
}
