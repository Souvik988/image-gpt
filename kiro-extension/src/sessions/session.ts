/**
 * Pure helpers for the KIRO Extension's local conversation store.
 *
 * Operates on the {@link Session} and {@link SessionMessage} value-types
 * declared in `@kiro-gpt-bridge/shared`; this module never re-defines
 * them. Every helper is pure: input sessions are treated as immutable
 * and a new value is returned via spread.
 *
 * Implements:
 *  - R15.1 — every newly opened thread receives a UUID v4 sessionId
 *    that is unique across the local machine.
 *  - R15.3 — outgoing requests carry the prior history of their session
 *    via {@link takeRecentMessages}.
 *  - R15.4 — the included history window is bounded to the inclusive
 *    range `[1, 200]`. Out-of-range values are clamped to the nearest
 *    bound; the `kiroGptBridge.sessionHistoryMax` user setting (default
 *    50) is enforced at the call site against the same clamp.
 *
 * The on-disk persistence layer lives in `sessions/store.ts`. This
 * module is I/O-free and deterministic given an injected clock.
 */

import { randomUUID } from 'node:crypto';
import type { Session, SessionMessage, SessionId } from '@kiro-gpt-bridge/shared';

/** Lower bound for the history window per R15.4. */
const HISTORY_MIN = 1;
/** Upper bound for the history window per R15.4. */
const HISTORY_MAX = 200;

/**
 * Clamp `n` to the inclusive range `[HISTORY_MIN, HISTORY_MAX]`. NaN and
 * non-finite values collapse to the lower bound; floats are floored so
 * `slice(-n)` operates on an integer.
 */
function clamp(n: number): number {
  if (!Number.isFinite(n)) {
    return HISTORY_MIN;
  }
  const floored = Math.floor(n);
  if (floored < HISTORY_MIN) {
    return HISTORY_MIN;
  }
  if (floored > HISTORY_MAX) {
    return HISTORY_MAX;
  }
  return floored;
}

/**
 * Create a fresh, empty {@link Session} whose `sessionId` is a freshly
 * generated UUID v4 and whose `createdAt` and `updatedAt` are stamped
 * with the current epoch ms.
 *
 * Implements R15.1.
 */
export function createSession(): Session {
  const t = Date.now();
  const sessionId: SessionId = randomUUID();
  return {
    sessionId,
    createdAt: t,
    updatedAt: t,
    messages: [],
  };
}

/**
 * Append a {@link SessionMessage} to `session` and return a NEW session
 * value; the input is never mutated. The appended message receives an
 * auto-generated UUID v4 `id` and a `createdAt` stamped with the current
 * epoch ms; the parent session's `updatedAt` is updated to the same
 * timestamp.
 *
 * @param session The existing session.
 * @param msg     Message payload — `id` and `createdAt` are filled in
 *                by this helper, every other {@link SessionMessage}
 *                field is taken verbatim.
 */
export function appendMessage(
  session: Session,
  msg: Omit<SessionMessage, 'id' | 'createdAt'>,
): Session {
  const t = Date.now();
  const newMessage: SessionMessage = {
    id: randomUUID(),
    createdAt: t,
    ...msg,
  };
  return {
    ...session,
    updatedAt: t,
    messages: [...session.messages, newMessage],
  };
}

/**
 * Return the last `n` messages of `session.messages` in chronological
 * order. The input is not mutated; a fresh array is always returned.
 *
 * Used by the request builder to assemble the `history` field on
 * outgoing requests per R15.3 / R15.4.
 *
 * @param n Maximum number of messages to retain. Per R15.4, `n` must
 *          lie in `[1, 200]`; values outside that range are clamped to
 *          the nearest bound. Non-finite or NaN inputs collapse to the
 *          lower bound, and floats are floored before clamping.
 */
export function takeRecentMessages(session: Session, n: number): SessionMessage[] {
  const cap = clamp(n);
  return session.messages.slice(-cap);
}

/**
 * Return a shallow copy of `session` with `messages` truncated to its
 * last `n` entries. The input is not mutated.
 *
 * Intended for tests and bookkeeping; production code calls
 * {@link takeRecentMessages} against the live session and never mutates
 * it.
 *
 * @param n Maximum number of messages to keep. Clamped to `[1, 200]`
 *          per R15.4 with the same rules as {@link takeRecentMessages}.
 */
export function truncateHistory(session: Session, n: number): Session {
  const cap = clamp(n);
  return {
    ...session,
    messages: session.messages.slice(-cap),
  };
}
