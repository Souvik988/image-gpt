/**
 * Browser Agent finite-state machine.
 *
 * Implements R8.6, R8.7, R8.9, R11.4, R11.5, R11.7. Reproduces the
 * "Browser Agent State Diagram" from `design.md` faithfully — the
 * legal-successor table below corresponds line-by-line to the
 * `stateDiagram-v2` block. Illegal transitions are logged via the
 * structured agent logger and thrown as `TypeError` so callers crash
 * fast in development rather than silently desyncing.
 *
 * Why a hand-rolled FSM rather than a library: the diagram has six
 * states and ~16 edges. A library (XState, robot, etc.) would dwarf
 * the surface area and add a transitive dependency footprint we want
 * to keep zero on the agent side. The runtime cost of the table here
 * is one `Set.has` per transition.
 *
 * The relaunch-attempt counter (R11.7) lives on the machine, not on
 * the chromium wrapper: it is reset when a relaunch succeeds and
 * incremented on each failure, so the wrapper only has to ask
 * "did we exceed `maxRelaunchAttempts`?" before scheduling another
 * `restarting -> restarting` transition.
 *
 * @packageDocumentation
 */

import { logAgentEvent } from '../log/logger.js';

/**
 * Closed set of Browser_Agent runtime states. Mirrors the
 * `AgentStatus` wire enum in `shared/src/schema.ts` but adds the
 * internal `booting` state used before the first `agent.status_from`
 * is sent to the relay.
 */
export type AgentState =
  | 'booting'
  | 'ready'
  | 'busy'
  | 'login_required'
  | 'restarting'
  | 'disconnected';

/**
 * Closed list of {@link AgentState} values for runtime iteration and
 * membership tests (e.g., validating an inbound state name without
 * touching the legal-transition table).
 */
export const AGENT_STATES: readonly AgentState[] = [
  'booting',
  'ready',
  'busy',
  'login_required',
  'restarting',
  'disconnected',
] as const;

/**
 * Per-state legal-successor table extracted from the design's
 * "Browser Agent State Diagram" (`design.md`, section
 * "Browser Agent State Diagram"). Each entry lists every state the
 * key state may legally transition INTO. Self-loops are explicit
 * (only `restarting -> restarting` exists per R11.7).
 *
 * Cross-check vs. design.md edges:
 *   booting        -> ready, login_required, restarting
 *   ready          -> busy, login_required, restarting, disconnected
 *   busy           -> ready, login_required, restarting, disconnected
 *   login_required -> ready, disconnected
 *   restarting     -> ready, login_required, restarting
 *   disconnected   -> ready, login_required, restarting
 */
const LEGAL: Record<AgentState, ReadonlySet<AgentState>> = {
  booting: new Set<AgentState>(['ready', 'login_required', 'restarting']),
  ready: new Set<AgentState>(['busy', 'login_required', 'restarting', 'disconnected']),
  busy: new Set<AgentState>(['ready', 'login_required', 'restarting', 'disconnected']),
  login_required: new Set<AgentState>(['ready', 'disconnected']),
  restarting: new Set<AgentState>(['ready', 'login_required', 'restarting']),
  disconnected: new Set<AgentState>(['ready', 'login_required', 'restarting']),
};

/**
 * Reason tag attached to every transition. Used for structured
 * logging and so listeners can react conditionally (e.g., "only
 * reset relaunch attempts on `chromium_relaunched`"). The union is
 * widened to `string` so callers can supply ad-hoc reasons in
 * tests / future event types without modifying this file, while
 * still benefiting from autocomplete on the canonical set.
 */
export type TransitionReason =
  | 'init'
  | 'chromium_ready'
  | 'auth_ready'
  | 'auth_lost'
  | 'auth_required'
  | 'login_complete'
  | 'dispatch_received'
  | 'response_final'
  | 'cancel_ack'
  | 'chromium_crash'
  | 'chromium_relaunched'
  | 'chromium_relaunch_failed'
  | 'socket_disconnected'
  | 'socket_reconnected'
  | string;

/**
 * Event delivered to {@link AgentStateMachine.onTransition} listeners
 * after a successful transition. `at` is captured via the injected
 * clock so tests can simulate time deterministically.
 */
export interface TransitionEvent {
  /** State the machine was in before the transition. */
  from: AgentState;
  /** State the machine is in after the transition. */
  to: AgentState;
  /** Reason tag supplied by the caller of `transition`. */
  reason: TransitionReason;
  /** Wall-clock epoch ms at the moment the transition fired. */
  at: number;
}

/**
 * Construction-time options for {@link createAgentStateMachine}.
 */
export interface AgentStateMachineOptions {
  /** Initial state. Defaults to `'booting'` per the diagram entry node. */
  initialState?: AgentState;
  /**
   * Maximum chromium relaunch attempts before the wrapper should
   * stop self-healing (R11.7). Defaults to 3. Note that the FSM
   * itself does not enforce the cap — it only counts attempts;
   * the chromium wrapper compares the count against this value.
   */
  maxRelaunchAttempts?: number;
  /** Clock injection point for tests; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Public surface of the Browser_Agent state machine.
 *
 * Implements R8.6 (typed FSM), R8.7 (busy → login_required only after
 * the in-flight request finishes), R8.9 (illegal transitions are
 * rejected and logged), R11.4 (chromium crash → `restarting`),
 * R11.5 (relaunch success path), and R11.7 (≤3 relaunch attempts).
 */
export interface AgentStateMachine {
  /** Read the current state. */
  state(): AgentState;
  /**
   * Attempt a transition to `next`. Throws `TypeError` on illegal
   * transitions; the failure is also emitted as a structured
   * `agent.error` log entry with `errorCategory: 'illegal_state_transition'`
   * (R8.9). On success, fires every listener registered via
   * {@link onTransition} AFTER the state has been committed.
   */
  transition(next: AgentState, reason: TransitionReason): void;
  /**
   * Subscribe to transition events. Listeners run synchronously in
   * registration order; a thrown listener is logged but does not
   * prevent subsequent listeners from running.
   */
  onTransition(handler: (event: TransitionEvent) => void): void;
  /**
   * Number of chromium relaunch attempts made so far in the current
   * `restarting` cycle. Reset by {@link resetRelaunchAttempts}.
   */
  relaunchAttempts(): number;
  /**
   * Reset the relaunch-attempt counter to zero. Called by the
   * chromium wrapper when a relaunch succeeds (R11.5).
   */
  resetRelaunchAttempts(): void;
  /**
   * Increment the relaunch-attempt counter and return the new value.
   * The chromium wrapper compares the returned value against
   * `maxRelaunchAttempts` (R11.7) to decide whether to schedule
   * another relaunch.
   */
  incrementRelaunchAttempts(): number;
}

/**
 * Build a fresh {@link AgentStateMachine}. Implements R8.6.
 *
 * The returned machine starts in `opts.initialState ?? 'booting'`,
 * uses `opts.now ?? Date.now` as its clock, and caps the
 * relaunch-attempt counter at `opts.maxRelaunchAttempts ?? 3`
 * (R11.7).
 */
export function createAgentStateMachine(
  opts?: AgentStateMachineOptions,
): AgentStateMachine {
  let current: AgentState = opts?.initialState ?? 'booting';
  const now = opts?.now ?? Date.now;
  // `maxRelaunch` is captured here for documentation completeness even
  // though the FSM does not enforce the cap itself — the chromium
  // wrapper consults `incrementRelaunchAttempts()` against this value.
  const maxRelaunch = opts?.maxRelaunchAttempts ?? 3;
  void maxRelaunch;
  let relaunchCount = 0;
  const listeners: ((event: TransitionEvent) => void)[] = [];

  function transition(next: AgentState, reason: TransitionReason): void {
    const allowed = LEGAL[current];
    if (!allowed.has(next)) {
      const msg = `illegal transition: ${current} -> ${next}`;
      logAgentEvent({
        eventType: 'agent.error',
        errorCategory: 'illegal_state_transition',
        from: current,
        to: next,
        reason,
      });
      throw new TypeError(msg);
    }
    const prev = current;
    current = next;
    logAgentEvent({
      eventType: 'agent.state_transition',
      from: prev,
      to: next,
      reason,
    });
    const event: TransitionEvent = { from: prev, to: next, reason, at: now() };
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        logAgentEvent({
          eventType: 'agent.error',
          errorCategory: 'state_listener',
          error: String(err),
        });
      }
    }
  }

  return {
    state: () => current,
    transition,
    onTransition: (handler) => {
      listeners.push(handler);
    },
    relaunchAttempts: () => relaunchCount,
    resetRelaunchAttempts: () => {
      relaunchCount = 0;
    },
    incrementRelaunchAttempts: () => ++relaunchCount,
  };
}
