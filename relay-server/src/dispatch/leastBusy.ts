/**
 * Pure least-busy selection over a set of idle agents.
 *
 * Implements R5.2: dispatcher SHALL select among Idle_Agent instances only,
 * using a least-busy strategy where workload is the count of Requests
 * dispatched to that Agent in the preceding 60 seconds, and SHALL break ties
 * by round-robin order based on the timestamp of the Agent's most recent
 * Request completion. An idle agent with no completion history is treated
 * as having the oldest possible completion timestamp for tie-breaking.
 *
 * The module is intentionally dependency-free so it stays trivially
 * testable; the structurally-compatible {@link LeastBusyAgent} interface
 * lets the agent pool (task 6.1) pass its `AgentState` directly.
 */

/**
 * Width of the workload sliding window in milliseconds (60 seconds, R5.2).
 */
export const RECENT_DISPATCHES_WINDOW_MS = 60_000;

/**
 * Snapshot of an agent's state used by the least-busy selector. The
 * concrete `AgentState` from `agentPool.ts` (task 6.1) is structurally
 * compatible with this — keeping this interface independent means this
 * module has no dependency on the pool module and is trivially testable.
 *
 * Implements R5.2.
 */
export interface LeastBusyAgent {
  /** Stable identifier of the agent. */
  readonly agentId: string;
  /**
   * Timestamps (ms, epoch) of recent dispatches to this agent. The
   * selector prunes entries outside the 60 s window IN PLACE so the
   * next call sees a fresh window without rescanning history.
   */
  recentDispatches: number[];
  /**
   * Last terminal-completion timestamp (ms, epoch). `null` when the
   * agent has no completion history yet — treated as the oldest
   * possible timestamp by the tie-breaker (R5.2).
   */
  readonly lastCompletionAt: number | null;
}

/**
 * Prune `recentDispatches` to the trailing 60 s window ending at `now`.
 * Mutates the array IN PLACE, in arrival order, retaining only entries
 * within `[now - RECENT_DISPATCHES_WINDOW_MS, now]`.
 *
 * Implements R5.2 (workload metric is the count within the trailing 60 s).
 *
 * @param dispatches In-place array of dispatch timestamps (ms epoch).
 * @param now Current clock value (ms epoch).
 */
function pruneToWindow(dispatches: number[], now: number): void {
  const cutoff = now - RECENT_DISPATCHES_WINDOW_MS;
  // Two-pointer in-place compaction. Stable order is preserved so the
  // array stays sorted if the caller appended in chronological order.
  let write = 0;
  for (let read = 0; read < dispatches.length; read++) {
    const ts = dispatches[read] as number;
    if (ts >= cutoff && ts <= now) {
      dispatches[write] = ts;
      write++;
    }
  }
  dispatches.length = write;
}

/**
 * Tie-break key for `lastCompletionAt`. A `null` history is treated as
 * `Number.NEGATIVE_INFINITY` so the agent is considered "least-recently
 * completed" (oldest possible) and is preferred over any agent with an
 * actual completion timestamp.
 *
 * Implements R5.2 (null-completion tie-break rule).
 */
function completionKey(a: LeastBusyAgent): number {
  return a.lastCompletionAt ?? Number.NEGATIVE_INFINITY;
}

/**
 * Select the most-eligible idle agent for a new dispatch.
 *
 * Algorithm (R5.2):
 *  1. For each candidate, prune `recentDispatches` to entries within
 *     `[now - 60_000, now]` IN PLACE so the next call sees a fresh window.
 *  2. Sort ascending by `recentDispatches.length` (the workload metric).
 *  3. Tie-break ascending by `lastCompletionAt`; `null` is treated as
 *     `Number.NEGATIVE_INFINITY` so an agent with no completions is
 *     considered "oldest" and is preferred over one with any completion.
 *  4. Return the first element after sorting.
 *
 * The caller's `idle` array order is NOT mutated — sorting happens on a
 * shallow copy so the caller can iterate `idle` afterwards in insertion
 * order. The agents themselves ARE mutated (their `recentDispatches`
 * arrays are pruned in place), which is intentional; the agent pool
 * owns those arrays and benefits from the prune.
 *
 * Implements R5.2.
 *
 * @param idle Idle agents only — the caller filters before calling.
 * @param now Optional clock; defaults to {@link Date.now}.
 * @returns The selected agent, or `null` when `idle` is empty.
 */
export function pickIdleAgent(
  idle: LeastBusyAgent[],
  now: () => number = Date.now,
): LeastBusyAgent | null {
  if (idle.length === 0) {
    return null;
  }

  const t = now();

  // Prune every candidate's window in place before measuring workload so
  // the comparator sees the up-to-date count.
  for (const agent of idle) {
    pruneToWindow(agent.recentDispatches, t);
  }

  // Sort a shallow copy so the caller's array order is preserved. Modern
  // V8 Array.prototype.sort is stable, which we rely on for deterministic
  // round-robin behaviour when both the workload and completion key are
  // equal.
  const sorted = idle.slice();
  sorted.sort((a, b) => {
    const workloadDelta = a.recentDispatches.length - b.recentDispatches.length;
    if (workloadDelta !== 0) return workloadDelta;
    return completionKey(a) - completionKey(b);
  });

  return sorted[0] ?? null;
}
