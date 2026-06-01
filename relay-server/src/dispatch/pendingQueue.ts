/**
 * FIFO pending-request queue with O(1) head/tail enqueue/dequeue and
 * O(1) cancel-by-id, plus a periodic reaper that emits `queue_timeout`
 * for any entry whose age exceeds `ttlMs`.
 *
 * Implements:
 *  - R6.1 (append a request when no idle agents are available)
 *  - R6.4 (FIFO ordering across simultaneous idle transitions)
 *  - R6.5 (max queue depth, default 1000)
 *  - R6.6 (return the literal `'FULL'` on capacity overflow)
 *  - R6.7 (600 s in-queue timeout enforced by a 1 Hz reaper)
 *  - R7.7 (`queue_timeout` is the terminal state surfaced by the reaper)
 *  - R27.8 (the reaper enforces the queue-timeout invariant)
 *
 * Implementation notes:
 *  - The queue is a doubly-linked list keyed into via `Map<RequestId, Node>`
 *    so that `removeById` is O(1) — required by client-disconnect cancel
 *    (R6.8) and head-of-queue cancel (R20.5) at scale.
 *  - The reaper uses `setInterval(...).unref()` so it never holds the
 *    Node.js event loop alive on its own.
 *  - This module is purely in-memory; durability is not a goal (R6 is
 *    explicitly best-effort at process scope).
 *
 * The reaper emits `queue_timeout` *after* the offending entry has
 * already been unlinked, so listeners can safely transition the request
 * to its terminal state without racing against another `popHead()`.
 */

import { EventEmitter } from 'node:events';
import type { Request, RequestId } from '@kiro-gpt-bridge/shared';

/** Default maximum queue depth (R6.5). */
const DEFAULT_MAX_DEPTH = 1000;

/** Default in-queue TTL in milliseconds (R6.7 — 10 minutes). */
const DEFAULT_TTL_MS = 600_000;

/** Default reaper tick period in milliseconds. */
const DEFAULT_REAPER_TICK_MS = 1_000;

/**
 * Construction options for {@link PendingQueue}. Every field is optional;
 * defaults match the design's R6 contract (depth 1000, TTL 600 s, 1 Hz
 * reaper).
 */
export interface QueueOptions {
  /** Max queue depth before `append` returns `'FULL'`. Default 1000 (R6.5). */
  maxDepth?: number;
  /** TTL ms after which a queued request is reaped. Default 600_000 (R6.7). */
  ttlMs?: number;
  /** Reaper tick period in ms. Default 1_000. */
  reaperTickMs?: number;
  /** Clock injection for tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * Snapshot returned by {@link PendingQueue.head} and
 * {@link PendingQueue.popHead}. Both fields are read-only because callers
 * must not mutate queue state through a returned entry.
 */
export interface QueueEntry {
  /** The original request payload as appended by the dispatcher. */
  readonly request: Request;
  /** Epoch ms (per the injected clock) when the request was enqueued. */
  readonly enqueuedAt: number;
}

/**
 * Event map for {@link PendingQueue}. Documents the closed set of events
 * the queue emits and the listener signature for each.
 *
 * - `queue_timeout` fires once per entry whose age has exceeded `ttlMs`.
 *   The entry has already been unlinked from the queue at the moment
 *   the listener runs (R6.7, R7.7).
 */
export interface QueueEvents {
  /** Emitted when a queued request times out (R6.7). The entry has already been removed. */
  queue_timeout: (entry: QueueEntry) => void;
}

/** Internal doubly-linked list node. Not exported. */
interface Node {
  entry: QueueEntry;
  prev: Node | null;
  next: Node | null;
}

/**
 * Strongly-typed `on`/`emit` overloads for {@link PendingQueue}. Declared
 * via interface-merging so the class can extend the untyped Node.js
 * `EventEmitter` while still giving call-sites compile-time event safety.
 */
export interface PendingQueue {
  on<K extends keyof QueueEvents>(event: K, listener: QueueEvents[K]): this;
  off<K extends keyof QueueEvents>(event: K, listener: QueueEvents[K]): this;
  once<K extends keyof QueueEvents>(event: K, listener: QueueEvents[K]): this;
  emit<K extends keyof QueueEvents>(event: K, ...args: Parameters<QueueEvents[K]>): boolean;
}

/**
 * FIFO pending-request queue. See module-level docstring for the full
 * contract; per-method TSDoc below documents complexity and edge cases.
 */
export class PendingQueue extends EventEmitter {
  private readonly maxDepth: number;
  private readonly ttlMs: number;
  private readonly reaperTickMs: number;
  private readonly now: () => number;

  private head_: Node | null = null;
  private tail_: Node | null = null;
  private size_ = 0;
  private readonly nodes: Map<RequestId, Node> = new Map();

  private reaperHandle: NodeJS.Timeout | null = null;
  private disposed = false;

  /**
   * Build a new queue and start the reaper. The reaper handle is
   * `unref()`-ed so it never keeps the event loop alive on its own.
   *
   * @param opts - {@link QueueOptions}; all fields optional.
   */
  constructor(opts?: QueueOptions) {
    super();
    this.maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.reaperTickMs = opts?.reaperTickMs ?? DEFAULT_REAPER_TICK_MS;
    this.now = opts?.now ?? Date.now;

    this.reaperHandle = setInterval(() => this.reap(), this.reaperTickMs);
    // Don't keep the Node.js event loop alive solely for the reaper.
    this.reaperHandle.unref?.();
  }

  /**
   * Append a request to the tail of the queue.
   *
   * Implements R6.1 (append on no-idle-agents) and R6.6 (`'FULL'` on
   * capacity overflow). O(1).
   *
   * @param request - The request to enqueue.
   * @returns The new 1-based queue position (i.e. the new size) when
   *          the append succeeded, or the literal `'FULL'` when the
   *          queue is already at `maxDepth`.
   */
  append(request: Request): number | 'FULL' {
    if (this.size_ >= this.maxDepth) {
      return 'FULL';
    }
    const entry: QueueEntry = {
      request,
      enqueuedAt: this.now(),
    };
    const node: Node = { entry, prev: this.tail_, next: null };
    if (this.tail_ !== null) {
      this.tail_.next = node;
    } else {
      // Empty queue → this node is also the head.
      this.head_ = node;
    }
    this.tail_ = node;
    this.nodes.set(request.requestId, node);
    this.size_ += 1;
    return this.size_;
  }

  /**
   * Remove and return the head entry.
   *
   * Implements the FIFO drain side of R6.4. O(1).
   *
   * @returns The previous head's {@link QueueEntry}, or `undefined` when
   *          the queue is empty.
   */
  popHead(): QueueEntry | undefined {
    const node = this.head_;
    if (node === null) {
      return undefined;
    }
    this.unlink(node);
    return node.entry;
  }

  /**
   * Remove a specific request by id, regardless of position.
   *
   * Implements head-of-queue cancel (R20.5) and client-disconnect
   * sweeping (R6.8). O(1) via the auxiliary `Map<RequestId, Node>`.
   *
   * @param requestId - The id of the request to remove.
   * @returns The removed {@link QueueEntry}, or `undefined` when no
   *          such request is queued.
   */
  removeById(requestId: RequestId): QueueEntry | undefined {
    const node = this.nodes.get(requestId);
    if (node === undefined) {
      return undefined;
    }
    this.unlink(node);
    return node.entry;
  }

  /**
   * Read-only peek at the head entry.
   *
   * @returns The head {@link QueueEntry}, or `undefined` when empty.
   */
  head(): QueueEntry | undefined {
    return this.head_?.entry;
  }

  /**
   * Read-only peek at any entry by id. Used by status emitters that
   * need to compute queue position from a known request id.
   *
   * @param requestId - The id of the request to look up.
   * @returns The matching {@link QueueEntry}, or `undefined` when not found.
   */
  nodeOf(requestId: RequestId): QueueEntry | undefined {
    return this.nodes.get(requestId)?.entry;
  }

  /**
   * Current queue depth.
   *
   * @returns The number of entries currently queued.
   */
  size(): number {
    return this.size_;
  }

  /**
   * Stop the reaper and release its timer handle. Idempotent — calling
   * `dispose` more than once is a no-op. The queue contents are left
   * untouched so any in-flight `removeById`/`popHead` callers remain
   * correct, but no further `queue_timeout` events will be emitted.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.reaperHandle !== null) {
      clearInterval(this.reaperHandle);
      this.reaperHandle = null;
    }
  }

  // ─── internals ──────────────────────────────────────────────────────────

  /**
   * Unlink a node from the doubly-linked list and the auxiliary map.
   * Updates head/tail/size as appropriate. O(1).
   */
  private unlink(node: Node): void {
    const { prev, next } = node;
    if (prev !== null) {
      prev.next = next;
    } else {
      // Was the head.
      this.head_ = next;
    }
    if (next !== null) {
      next.prev = prev;
    } else {
      // Was the tail.
      this.tail_ = prev;
    }
    node.prev = null;
    node.next = null;
    this.nodes.delete(node.entry.request.requestId);
    this.size_ -= 1;
  }

  /**
   * Reaper tick. Walks from the head while `enqueuedAt < now - ttlMs`,
   * unlinks each stale node, and emits `queue_timeout` for it. Because
   * entries are appended in monotonically-increasing `now()` order the
   * scan can stop at the first non-stale node.
   *
   * Implements R6.7 / R27.8.
   */
  private reap(): void {
    if (this.disposed) {
      return;
    }
    const cutoff = this.now() - this.ttlMs;
    while (this.head_ !== null && this.head_.entry.enqueuedAt < cutoff) {
      const node = this.head_;
      this.unlink(node);
      this.emit('queue_timeout', node.entry);
    }
  }
}
