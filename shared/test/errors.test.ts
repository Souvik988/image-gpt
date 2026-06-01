import { describe, it, expect } from 'vitest';
import { ERROR_CODES, isErrorCode, type ErrorCode } from '../src/errors.js';

/**
 * Snapshot tests for `shared/src/errors.ts`. Locks the closed wire-level
 * error-code enum so any addition or removal triggers an explicit, visible
 * test diff rather than silently changing the contract that all three
 * components (kiro-extension, relay-server, browser-agent, mcp-server) rely
 * on. Implements R26.5 / R26.6 by ensuring no new code is admitted to the
 * union without updating this file.
 */
describe('ERROR_CODES wire contract', () => {
  it('matches the documented closed list exactly and in declaration order', () => {
    // The exact tuple is the wire contract — any change here MUST also be
    // reflected in design.md "Error Code Taxonomy" and in every consumer.
    const expected: readonly string[] = [
      'PAYLOAD_TOO_LARGE',
      'SCHEMA_INVALID',
      'MALFORMED_INPUT',
      'MESSAGE_TOO_LARGE',
      'QUEUE_FULL',
      'QUEUE_TIMEOUT',
      'AGENT_DISCONNECTED',
      'CHATGPT_ERROR',
      'CHATGPT_UNAVAILABLE',
      'INPUT_UNAVAILABLE',
      'CHAT_TIMEOUT',
      'IMAGE_TIMEOUT',
      'CONTENT_POLICY',
      'INVALID_PROMPT',
      'CANCEL_DELIVERY_FAILED',
      'SHUTDOWN',
      'AUTH_FAILED',
      'CAPACITY_EXCEEDED',
      'WORKSPACE_REQUIRED',
      'TARGET_EXISTS',
      'RELAY_UNREACHABLE',
    ];

    expect([...ERROR_CODES]).toEqual(expected);
  });

  it('contains exactly 21 distinct codes', () => {
    expect(ERROR_CODES.length).toBe(21);
    const unique = new Set<string>(ERROR_CODES);
    expect(unique.size).toBe(ERROR_CODES.length);
  });

  it('matches the snapshot of the closed enum', () => {
    expect(ERROR_CODES).toMatchInlineSnapshot(`
      [
        "PAYLOAD_TOO_LARGE",
        "SCHEMA_INVALID",
        "MALFORMED_INPUT",
        "MESSAGE_TOO_LARGE",
        "QUEUE_FULL",
        "QUEUE_TIMEOUT",
        "AGENT_DISCONNECTED",
        "CHATGPT_ERROR",
        "CHATGPT_UNAVAILABLE",
        "INPUT_UNAVAILABLE",
        "CHAT_TIMEOUT",
        "IMAGE_TIMEOUT",
        "CONTENT_POLICY",
        "INVALID_PROMPT",
        "CANCEL_DELIVERY_FAILED",
        "SHUTDOWN",
        "AUTH_FAILED",
        "CAPACITY_EXCEEDED",
        "WORKSPACE_REQUIRED",
        "TARGET_EXISTS",
        "RELAY_UNREACHABLE",
      ]
    `);
  });
});

describe('isErrorCode', () => {
  it('accepts every value in ERROR_CODES', () => {
    for (const code of ERROR_CODES) {
      expect(isErrorCode(code)).toBe(true);
    }
  });

  it('rejects strings not in the enum', () => {
    expect(isErrorCode('NOT_A_CODE')).toBe(false);
    expect(isErrorCode('schema_invalid')).toBe(false); // case-sensitive
    expect(isErrorCode('')).toBe(false);
    expect(isErrorCode('PAYLOAD_TOO_LARGE ')).toBe(false); // trailing space
  });

  it('rejects non-string inputs', () => {
    expect(isErrorCode(undefined)).toBe(false);
    expect(isErrorCode(null)).toBe(false);
    expect(isErrorCode(0)).toBe(false);
    expect(isErrorCode(false)).toBe(false);
    expect(isErrorCode({})).toBe(false);
    expect(isErrorCode([])).toBe(false);
    expect(isErrorCode(Symbol('SCHEMA_INVALID'))).toBe(false);
  });

  it('narrows to ErrorCode at compile time', () => {
    const value: unknown = 'SCHEMA_INVALID';
    if (isErrorCode(value)) {
      // Must compile without a cast — value is now `ErrorCode`.
      const narrowed: ErrorCode = value;
      expect(narrowed).toBe('SCHEMA_INVALID');
    } else {
      throw new Error('isErrorCode should accept SCHEMA_INVALID');
    }
  });
});
