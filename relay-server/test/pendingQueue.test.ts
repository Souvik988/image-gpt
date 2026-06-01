/**
 * Unit tests for relay-server/src/dispatch/pendingQueue.ts — task 6.6.
 *
 * Covers: FIFO ordering, removeById from head/middle/tail, QUEUE_FULL
 * at capacity, reaper firing at 600_000 ms.
 *
 * Implements R6.1, R6.4, R6.5, R6.6, R6.7.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { PendingQueue } from '../src/dispatch/pendingQueue.js';
import type { Request } from '@kiro-gpt-bridge/shared';

/** Create a minimal valid Request stub for testing. */
function makeRequest(id: string): Request {
  return {
    protocolVersion: 1,
    requestId: id,
    clientId: 'client-1',
    sessionId: 'session-1',
    type: 'chat',
    prompt: 'hello',
    submittedAt: Date.now(),
  };
}

let queue: PendingQueue | null = null;

afterEach(() => {
  queue?.dispose();
  queue = null;
});

describe('pendingQueue.ts — FIFO ordering', () => {
  it('pops entries in the order they were appended', () => {
    queue = new PendingQueue({ maxDepth: 10, now: () => 1000 });
    queue.append(makeRequest('r1'));
    queue.append(makeRequest('r2'));
    queue.append(makeRequest('r3'));

    expect(queue.popHead()?.request.requestId).toBe('r1');
    expect(queue.popHead()?.request.requestId).toBe('r2');
    expect(queue.popHead()?.request.requestId).toBe('r3');
    expect(queue.popHead()).toBeUndefined();
  });

  it('reports correct size after appends and pops', () => {
    queue = new PendingQueue({ maxDepth: 10, now: () => 1000 });
    expect(queue.size()).toBe(0);
    queue.append(makeRequest('r1'));
    expect(queue.size()).toBe(1);
    queue.append(makeRequest('r2'));
    expect(queue.size()).toBe(2);
    queue.popHead();
    expect(queue.size()).toBe(1);
  });

  it('head() peeks without removing', () => {
    queue = new PendingQueue({ maxDepth: 10, now: () => 1000 });
    queue.append(makeRequest('r1'));
    queue.append(makeRequest('r2'));
    expect(queue.head()?.request.requestId).toBe('r1');
    expect(queue.size()).toBe(2);
  });
});

describe('pendingQueue.ts — removeById', () => {
  it('removes from head', () => {
    queue = new PendingQueue({ maxDepth: 10, now: () => 1000 });
    queue.append(makeRequest('r1'));
    queue.append(makeRequest('r2'));
    queue.append(makeRequest('r3'));

    const removed = queue.removeById('r1');
    expect(removed?.request.requestId).toBe('r1');
    expect(queue.size()).toBe(2);
    expect(queue.popHead()?.request.requestId).toBe('r2');
  });

  it('removes from middle', () => {
    queue = new PendingQueue({ maxDepth: 10, now: () => 1000 });
    queue.append(makeRequest('r1'));
    queue.append(makeRequest('r2'));
    queue.append(makeRequest('r3'));

    const removed = queue.removeById('r2');
    expect(removed?.request.requestId).toBe('r2');
    expect(queue.size()).toBe(2);
    expect(queue.popHead()?.request.requestId).toBe('r1');
    expect(queue.popHead()?.request.requestId).toBe('r3');
  });

  it('removes from tail', () => {
    queue = new PendingQueue({ maxDepth: 10, now: () => 1000 });
    queue.append(makeRequest('r1'));
    queue.append(makeRequest('r2'));
    queue.append(makeRequest('r3'));

    const removed = queue.removeById('r3');
    expect(removed?.request.requestId).toBe('r3');
    expect(queue.size()).toBe(2);
    expect(queue.popHead()?.request.requestId).toBe('r1');
    expect(queue.popHead()?.request.requestId).toBe('r2');
  });

  it('returns undefined for non-existent id', () => {
    queue = new PendingQueue({ maxDepth: 10, now: () => 1000 });
    queue.append(makeRequest('r1'));
    expect(queue.removeById('nonexistent')).toBeUndefined();
    expect(queue.size()).toBe(1);
  });
});

describe('pendingQueue.ts — QUEUE_FULL', () => {
  it('returns "FULL" when at capacity', () => {
    queue = new PendingQueue({ maxDepth: 3, now: () => 1000 });
    expect(queue.append(makeRequest('r1'))).toBe(1);
    expect(queue.append(makeRequest('r2'))).toBe(2);
    expect(queue.append(makeRequest('r3'))).toBe(3);
    expect(queue.append(makeRequest('r4'))).toBe('FULL');
    expect(queue.size()).toBe(3);
  });

  it('allows append after removing an entry from a full queue', () => {
    queue = new PendingQueue({ maxDepth: 2, now: () => 1000 });
    queue.append(makeRequest('r1'));
    queue.append(makeRequest('r2'));
    expect(queue.append(makeRequest('r3'))).toBe('FULL');

    queue.popHead();
    expect(queue.append(makeRequest('r3'))).toBe(2);
  });
});

describe('pendingQueue.ts — reaper at 600_000 ms', () => {
  it('emits queue_timeout for entries older than 600_000 ms', async () => {
    let currentTime = 1_000_000;
    queue = new PendingQueue({
      maxDepth: 10,
      ttlMs: 600_000,
      reaperTickMs: 50, // fast tick for testing
      now: () => currentTime,
    });

    queue.append(makeRequest('r1')); // enqueued at t=1_000_000
    currentTime += 100_000;
    queue.append(makeRequest('r2')); // enqueued at t=1_100_000

    const timedOut: string[] = [];
    queue.on('queue_timeout', (entry) => {
      timedOut.push(entry.request.requestId);
    });

    // Advance time past the TTL for r1 but not r2
    currentTime = 1_000_000 + 600_001;

    // Wait for the reaper to fire
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(timedOut).toContain('r1');
    expect(timedOut).not.toContain('r2');
    expect(queue.size()).toBe(1);
    expect(queue.head()?.request.requestId).toBe('r2');
  });

  it('reaps multiple entries in FIFO order when all are expired', async () => {
    let currentTime = 1_000_000;
    queue = new PendingQueue({
      maxDepth: 10,
      ttlMs: 600_000,
      reaperTickMs: 50,
      now: () => currentTime,
    });

    queue.append(makeRequest('r1'));
    currentTime += 1_000;
    queue.append(makeRequest('r2'));
    currentTime += 1_000;
    queue.append(makeRequest('r3'));

    const timedOut: string[] = [];
    queue.on('queue_timeout', (entry) => {
      timedOut.push(entry.request.requestId);
    });

    // Advance past TTL for all entries
    currentTime = 1_000_000 + 700_000;

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(timedOut).toEqual(['r1', 'r2', 'r3']);
    expect(queue.size()).toBe(0);
  });

  it('does not reap entries that are within TTL', async () => {
    let currentTime = 1_000_000;
    queue = new PendingQueue({
      maxDepth: 10,
      ttlMs: 600_000,
      reaperTickMs: 50,
      now: () => currentTime,
    });

    queue.append(makeRequest('r1'));

    const timedOut: string[] = [];
    queue.on('queue_timeout', (entry) => {
      timedOut.push(entry.request.requestId);
    });

    // Advance time but stay within TTL
    currentTime = 1_000_000 + 500_000;

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(timedOut).toHaveLength(0);
    expect(queue.size()).toBe(1);
  });
});
