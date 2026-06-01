/**
 * Single source of truth for the lifecycle state of every {@link Request}
 * the relay has acknowledged. The table is the in-memory record that
 * makes R7.2 (every Request is in exactly one state), R7.6 (every
 * acknowledged Request reaches a terminal state), R7.8 (≤ 3
 * redispatches), and R27.1 (no-loss invariant) machine-checkable: state
 * transitions are gated by a closed legal-predecessor table; illegal
 * transitions throw `TypeError` so the relay crashes loud rather than
 * silently corrupting state.
 *
 * The lifecycle mirrors the "Request Lifecycle" state diagram in
 * design.md exactly.
 */

import type { Request, RequestId, AgentId, ClientId } from '@kiro-gpt-bridge/shared';

/**
 * Internal lifecycle state of a tracked request. Mirrors the
 * "Request Lifecycle" state diagram in design.md: `received`, `queued`,
 * `dispatched`, and `in_flight` are non-terminal working states;
 * `cancelling` is the transient state between a cancel signal and the
 * agent's stop-ack; `completed`, `cancelled`, `failed`, and
 * `queue_timeout` are terminal.
 */
export type TrackedState =
  | 'received'
  | 'queued'
  | 'dispatched'
  | 'in_flight'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'queue_timeout';

/**
 * Closed list of all {@link TrackedState} values for iteration and
 * membership tests. Order matches the lifecycle diagram (entry states
 * first, then terminal states).
 */
export const TRACKED_STATES: readonly TrackedState[] = [
  'received',
  'queued',
  'dispatched',
  'in_flight',
  'cancelling',
  'completed',
  'cancelled',
  'failed',
  'queue_timeout',
] as const;

/**
 * Closed set of terminal states: once a record reaches one of these it
 * never transitions again. R7.6 requires every acknowledged request to
 * eventually land in this set.
 */
export const TERMINAL_TRACKED_STATES: ReadonlySet<TrackedState> = new Set<TrackedState>([
  'completed',
  'cancelled',
  'failed',
  'queue_timeout',
]);

/**
 * Per-state legal-successor table. A transition `from → to` is legal iff
 * `to ∈ LEGAL_TRANSITIONS[from]`. Terminal states map to the empty set:
 * any further transition is rejected.
 *
 * Sources (taken from design.md "Request Lifecycle"):
 *  - `received      → dispatched | queued`
 *  - `queued        → dispatched | cancelled | queue_timeout`
 *  - `dispatched    → in_flight | queued` (queued covers
 *                     ack-timeout-restore-to-head)
 *  - `in_flight     → completed | cancelling | failed | dispatched`
 *                     (dispatched covers re-dispatch on agent fail)
 *  - `cancelling    → cancelled | failed`
 *  - terminal states have no legal successor.
 */
const LEGAL_TRANSITIONS: Record<TrackedState, ReadonlySet<TrackedState>> = {
  received: new Set<TrackedState>(['dispatched', 'queued']),
  queued: new Set<TrackedState>(['dispatched', 'cancelled', 'queue_timeout']),
  dispatched: new Set<TrackedState>(['in_flight', 'queued']),
  in_flight: new Set<TrackedState>(['completed', 'cancelling', 'failed', 'dispatched']),
  cancelling: new Set<TrackedState>(['cancelled', 'failed']),
  completed: new Set<TrackedState>(),
  cancelled: new Set<TrackedState>(),
  failed: new Set<TrackedState>(),
  queue_timeout: new Set<TrackedState>(),
};

/**
 * The maximum number of redispatch attempts allowed for a single
 * request. R7.8 caps the retry budget at 3.
 */
const MAX_REDISPATCH_COUNT = 3;

/**
 * One row of the {@link RequestTable}. Carries the original
 * {@link Request} payload, the current lifecycle state, and the
 * timestamps and counters the dispatcher mutates over the request's
 * lifetime.
 *
 * `request`, `clientId`, and `receivedAt` are immutable: they are set on
 * insertion and never change. All other fields are mutable so the
 * dispatcher can update them via {@link RequestTable.transition} (for
 * `state`, `agentId`, `enqueuedAt`, `dispatchedAt`) and
 * {@link RequestTable.bumpRedispatch} (for `redispatchCount`).
 */
export interface RequestRecord {
  /** Original request payload, captured at insertion. */
  readonly request: Request;
  /** Current lifecycle position. R7.2. */
  state: TrackedState;
  /** Agent currently assigned to the request, or `null` until dispatch. */
  agentId: AgentId | null;
  /** Client that originated the request. */
  readonly clientId: ClientId;
  /** Epoch ms when the relay acknowledged the request. */
  readonly receivedAt: number;
  /** Epoch ms when the request entered the pending queue, or `null`. */
  enqueuedAt: number | null;
  /** Epoch ms when the request was dispatched to an agent, or `null`. */
  dispatchedAt: number | null;
  /** Number of redispatch attempts so far. ≤ 3 per R7.8. */
  redispatchCount: number;
}

/**
 * Fields of {@link RequestRecord} that may be patched as part of a
 * {@link RequestTable.transition} call. Restricting the patch surface
 * here keeps state-changing concerns (state + dispatch metadata) in one
 * place and prevents callers from rewriting immutable provenance fields
 * (`request`, `clientId`, `receivedAt`) or the retry counter (which has
 * its own dedicated mutator).
 */
export type RequestRecordPatch = Partial<Pick<RequestRecord, 'agentId' | 'enqueuedAt' | 'dispatchedAt'>>;

/**
 * Single source of truth for the lifecycle state of every Request the
 * relay has acknowledged. Implements R7.2 (every Request in exactly one
 * state), R7.6 (acknowledged ⇒ reaches a terminal state), R7.8 (≤ 3
 * redispatches), R27.1 (no-loss invariant).
 *
 * State transitions are gated by the legal-predecessor table; illegal
 * transitions throw a `TypeError` naming the from→to pair so the relay
 * crashes loud rather than silently corrupting state.
 */
export class RequestTable {
  /** Backing storage. Keyed by {@link Request.requestId}. */
  private readonly records: Map<RequestId, RequestRecord> = new Map();

  /**
   * Insert a freshly-received {@link Request}. The new record starts in
   * the `received` state with no agent assignment, no queue or dispatch
   * timestamps, and a redispatch count of zero.
   *
   * The caller (the Socket.IO submit handler) is responsible for
   * deduplicating retransmits per R21.4; this method enforces the same
   * invariant defensively and throws `TypeError` on a duplicate id.
   *
   * @param request The acknowledged request payload.
   * @param receivedAt Epoch ms when the relay acknowledged the request.
   * @returns The newly-tracked {@link RequestRecord}.
   * @throws `TypeError` if `request.requestId` is already tracked.
   */
  add(request: Request, receivedAt: number): RequestRecord {
    if (this.records.has(request.requestId)) {
      throw new TypeError(`duplicate requestId: ${request.requestId}`);
    }
    const record: RequestRecord = {
      request,
      state: 'received',
      agentId: null,
      clientId: request.clientId,
      receivedAt,
      enqueuedAt: null,
      dispatchedAt: null,
      redispatchCount: 0,
    };
    this.records.set(request.requestId, record);
    return record;
  }

  /**
   * Look up the record for a request id.
   *
   * @returns The {@link RequestRecord}, or `undefined` if no such id is
   *   tracked.
   */
  get(requestId: RequestId): RequestRecord | undefined {
    return this.records.get(requestId);
  }

  /**
   * Move a tracked request to `nextState`. Validates the transition
   * against {@link LEGAL_TRANSITIONS}; the optional `patch` is applied
   * after the state change so callers can record dispatch metadata
   * alongside the transition (e.g. `agentId` + `dispatchedAt` when
   * moving `received → dispatched`).
   *
   * The transition itself only mutates `state`. Provenance fields
   * (`request`, `clientId`, `receivedAt`) are immutable and the retry
   * counter has its own mutator ({@link bumpRedispatch}); neither is
   * reachable through the patch surface.
   *
   * @throws `TypeError` if the request id is unknown.
   * @throws `TypeError` if the transition is illegal per the
   *   legal-predecessor table. The message is exactly
   *   `"illegal transition: <from> -> <to>"` so log consumers can match
   *   on it.
   */
  transition(requestId: RequestId, nextState: TrackedState, patch?: RequestRecordPatch): RequestRecord {
    const record = this.records.get(requestId);
    if (record === undefined) {
      throw new TypeError(`unknown requestId: ${requestId}`);
    }
    const allowed = LEGAL_TRANSITIONS[record.state];
    if (!allowed.has(nextState)) {
      throw new TypeError(`illegal transition: ${record.state} -> ${nextState}`);
    }
    record.state = nextState;
    if (patch !== undefined) {
      if (patch.agentId !== undefined) {
        record.agentId = patch.agentId;
      }
      if (patch.enqueuedAt !== undefined) {
        record.enqueuedAt = patch.enqueuedAt;
      }
      if (patch.dispatchedAt !== undefined) {
        record.dispatchedAt = patch.dispatchedAt;
      }
    }
    return record;
  }

  /**
   * Increment `redispatchCount`. Implements R7.8: the relay is allowed
   * at most three redispatch attempts per request; the fourth call
   * throws `TypeError` so the dispatcher fails fast and transitions the
   * request to `failed` with `AGENT_DISCONNECTED`.
   *
   * @throws `TypeError` if the request id is unknown.
   * @throws `TypeError` if the increment would exceed 3.
   */
  bumpRedispatch(requestId: RequestId): RequestRecord {
    const record = this.records.get(requestId);
    if (record === undefined) {
      throw new TypeError(`unknown requestId: ${requestId}`);
    }
    if (record.redispatchCount >= MAX_REDISPATCH_COUNT) {
      throw new TypeError(
        `redispatch cap exceeded for ${requestId}: ${record.redispatchCount + 1} > ${MAX_REDISPATCH_COUNT}`,
      );
    }
    record.redispatchCount += 1;
    return record;
  }

  /**
   * Remove a record from the table. Intended to be called only after the
   * record has reached a terminal state (the caller's responsibility);
   * this method does not enforce that, because the dispatcher may also
   * want to drop entries during shutdown.
   *
   * @returns `true` when a record was present and has been removed,
   *   `false` when the id was unknown.
   */
  delete(requestId: RequestId): boolean {
    return this.records.delete(requestId);
  }

  /**
   * Iterate over every currently-tracked record. The iterator reflects
   * the underlying `Map` insertion order; callers must not mutate the
   * table mid-iteration.
   */
  values(): IterableIterator<RequestRecord> {
    return this.records.values();
  }

  /**
   * Returns `true` iff the record for `requestId` exists and its state
   * is in {@link TERMINAL_TRACKED_STATES}. Unknown ids yield `false`.
   */
  isTerminal(requestId: RequestId): boolean {
    const record = this.records.get(requestId);
    if (record === undefined) {
      return false;
    }
    return TERMINAL_TRACKED_STATES.has(record.state);
  }

  /** Number of records currently tracked. */
  size(): number {
    return this.records.size;
  }
}
