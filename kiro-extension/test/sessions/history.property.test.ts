// Feature: kiro-gpt-bridge, Property 14: takeRecentMessages(s, n) returns the last min(n, len(s.messages)) messages in original order
/**
 * Property test for session-history window.
 *
 * Generates sessions with varying message counts and history window sizes,
 * then asserts that the outgoing history equals the last min(k, N) messages
 * in chronological order.
 *
 * **Validates: Requirements 15.3, 15.4**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { takeRecentMessages } from '../../src/sessions/session.js';
import type { Session, SessionMessage } from '@kiro-gpt-bridge/shared';

function makeMessages(count: number): SessionMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `message ${i}`,
    createdAt: 1000 + i,
  }));
}

function makeSession(messages: SessionMessage[]): Session {
  return {
    sessionId: 'test-session',
    createdAt: 1000,
    updatedAt: 1000 + messages.length,
    messages,
  };
}

describe('Property 14: Session-history window', () => {
  it('outgoing history equals the last min(k, N) messages of the session in chronological order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 1, max: 200 }),
        (k, N) => {
          const messages = makeMessages(k);
          const session = makeSession(messages);

          const result = takeRecentMessages(session, N);

          // Length should be min(k, N) — but N is clamped to [1, 200]
          const expectedLen = Math.min(k, N);
          expect(result).toHaveLength(expectedLen);

          // Result should be the last expectedLen messages in original order
          const expected = messages.slice(-expectedLen);
          expect(result).toEqual(expected);

          // Verify chronological order
          for (let i = 1; i < result.length; i++) {
            expect(result[i]!.createdAt).toBeGreaterThanOrEqual(
              result[i - 1]!.createdAt,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
