/**
 * Unit tests for relay-server/src/dispatch/leastBusy.ts — task 6.5.
 *
 * Covers: empty pool, single agent, ties broken by lastCompletionAt,
 * null treated as oldest.
 *
 * Implements R5.2.
 */

import { describe, it, expect } from 'vitest';
import { pickIdleAgent, type LeastBusyAgent } from '../src/dispatch/leastBusy.js';

/** Helper to create an agent with sensible defaults. */
function makeAgent(overrides: Partial<LeastBusyAgent> & { agentId: string }): LeastBusyAgent {
  return {
    recentDispatches: [],
    lastCompletionAt: null,
    ...overrides,
  };
}

describe('leastBusy.ts — pickIdleAgent', () => {
  const fixedNow = (): number => 1_000_000;

  it('returns null for an empty pool', () => {
    const result = pickIdleAgent([], fixedNow);
    expect(result).toBeNull();
  });

  it('returns the single agent when pool has one entry', () => {
    const agent = makeAgent({ agentId: 'a1' });
    const result = pickIdleAgent([agent], fixedNow);
    expect(result).toBe(agent);
  });

  it('selects the agent with fewer recent dispatches', () => {
    const now = 1_000_000;
    const a1 = makeAgent({
      agentId: 'a1',
      recentDispatches: [now - 10_000, now - 20_000, now - 30_000],
    });
    const a2 = makeAgent({
      agentId: 'a2',
      recentDispatches: [now - 5_000],
    });
    const result = pickIdleAgent([a1, a2], () => now);
    expect(result?.agentId).toBe('a2');
  });

  it('breaks ties by lastCompletionAt (oldest completion wins)', () => {
    const now = 1_000_000;
    const a1 = makeAgent({
      agentId: 'a1',
      recentDispatches: [now - 10_000],
      lastCompletionAt: now - 5_000, // more recent completion
    });
    const a2 = makeAgent({
      agentId: 'a2',
      recentDispatches: [now - 10_000],
      lastCompletionAt: now - 50_000, // older completion → preferred
    });
    const result = pickIdleAgent([a1, a2], () => now);
    expect(result?.agentId).toBe('a2');
  });

  it('treats null lastCompletionAt as oldest (preferred in tie-break)', () => {
    const now = 1_000_000;
    const a1 = makeAgent({
      agentId: 'a1',
      recentDispatches: [now - 10_000],
      lastCompletionAt: now - 100_000, // has a completion
    });
    const a2 = makeAgent({
      agentId: 'a2',
      recentDispatches: [now - 10_000],
      lastCompletionAt: null, // null → treated as oldest → preferred
    });
    const result = pickIdleAgent([a1, a2], () => now);
    expect(result?.agentId).toBe('a2');
  });

  it('prunes dispatches outside the 60s window before comparing', () => {
    const now = 1_000_000;
    const a1 = makeAgent({
      agentId: 'a1',
      // All dispatches are older than 60s → pruned to 0
      recentDispatches: [now - 70_000, now - 80_000, now - 90_000],
    });
    const a2 = makeAgent({
      agentId: 'a2',
      // One dispatch within window
      recentDispatches: [now - 5_000],
    });
    const result = pickIdleAgent([a1, a2], () => now);
    // After pruning, a1 has 0 dispatches, a2 has 1 → a1 wins
    expect(result?.agentId).toBe('a1');
  });

  it('does not mutate the caller array order', () => {
    const now = 1_000_000;
    const a1 = makeAgent({ agentId: 'a1', recentDispatches: [now - 5_000, now - 6_000] });
    const a2 = makeAgent({ agentId: 'a2', recentDispatches: [] });
    const pool = [a1, a2];
    pickIdleAgent(pool, () => now);
    // Original array order preserved
    expect(pool[0]?.agentId).toBe('a1');
    expect(pool[1]?.agentId).toBe('a2');
  });

  it('selects correctly among multiple agents with varying workloads', () => {
    const now = 1_000_000;
    const a1 = makeAgent({ agentId: 'a1', recentDispatches: [now - 1_000, now - 2_000, now - 3_000] });
    const a2 = makeAgent({ agentId: 'a2', recentDispatches: [now - 1_000, now - 2_000] });
    const a3 = makeAgent({ agentId: 'a3', recentDispatches: [now - 1_000] });
    const result = pickIdleAgent([a1, a2, a3], () => now);
    expect(result?.agentId).toBe('a3');
  });
});
