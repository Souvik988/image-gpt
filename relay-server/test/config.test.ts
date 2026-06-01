/**
 * Unit tests for relay-server/src/config.ts — task 4.5.
 *
 * Covers: invalid PORT, missing/short/long secrets, TLS enabled without
 * cert, invalid QUEUE_MAX_DEPTH. Asserts exit non-zero + structured error.
 *
 * Implements R1.2, R2.4, R2.5, R6.5.
 */

import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

/** Minimal valid env for tests that only want to break one variable. */
function validEnv(): NodeJS.ProcessEnv {
  return {
    PORT: '3001',
    KIRO_SECRET: 'a-valid-secret-16ch',
    AGENT_SECRET: 'another-valid-16ch!',
    RELAY_TLS_ENABLED: 'false',
    QUEUE_MAX_DEPTH: '1000',
  };
}

/**
 * Helper that calls loadConfig with a stubbed exit and stderr, expecting
 * the config loader to call exit(1). Returns the structured error JSON
 * line that was emitted to stderr.
 */
function expectFatalExit(env: NodeJS.ProcessEnv): { exitCode: number; errorLine: string } {
  let exitCode = -1;
  let errorLine = '';

  const exit = ((code: number): never => {
    exitCode = code;
    throw new Error(`EXIT_${code}`);
  }) as (code: number) => never;

  const stderr = (line: string): void => {
    errorLine = line;
  };

  try {
    loadConfig(env, { exit, stderr });
  } catch (e: unknown) {
    if (!(e instanceof Error) || !e.message.startsWith('EXIT_')) {
      throw e;
    }
  }

  return { exitCode, errorLine };
}

describe('config.ts — invalid PORT', () => {
  it('rejects PORT = 0 (below range)', () => {
    const env = { ...validEnv(), PORT: '0' };
    const { exitCode, errorLine } = expectFatalExit(env);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(errorLine) as Record<string, unknown>;
    expect(parsed.variable).toBe('PORT');
    expect(parsed.level).toBe('error');
    expect(parsed.event).toBe('config.invalid');
  });

  it('rejects PORT = 70000 (above range)', () => {
    const env = { ...validEnv(), PORT: '70000' };
    const { exitCode, errorLine } = expectFatalExit(env);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(errorLine) as Record<string, unknown>;
    expect(parsed.variable).toBe('PORT');
    expect(parsed.rule).toBe('integer in [1, 65535]');
  });

  it('rejects PORT = "abc" (non-numeric)', () => {
    const env = { ...validEnv(), PORT: 'abc' };
    const { exitCode, errorLine } = expectFatalExit(env);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(errorLine) as Record<string, unknown>;
    expect(parsed.variable).toBe('PORT');
  });

  it('rejects PORT = "3.14" (non-integer)', () => {
    const env = { ...validEnv(), PORT: '3.14' };
    const { exitCode, errorLine } = expectFatalExit(env);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(errorLine) as Record<string, unknown>;
    expect(parsed.variable).toBe('PORT');
  });
});

describe('config.ts — missing/short/long secrets', () => {
  it('rejects missing KIRO_SECRET', () => {
    const env = { ...validEnv() };
    delete env.KIRO_SECRET;
    const { exitCode, errorLine } = expectFatalExit(env);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(errorLine) as Record<string, unknown>;
    expect(parsed.variable).toBe('KIRO_SECRET');
    expect(parsed.message).toBe('unset');
  });

  it('rejects short KIRO_SECRET (15 chars)', () => {
    const env = { ...validEnv(), KIRO_SECRET: 'a'.repeat(15) };
    const { exitCode, errorLine } = expectFatalExit(env);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(errorLine) as Record<string, unknown>;
    expect(parsed.variable).toBe('KIRO_SECRET');
    expect(parsed.message).toBe('length 15');
  });

  it('rejects long AGENT_SECRET (257 chars)', () => {
    const env = { ...validEnv(), AGENT_SECRET: 'b'.repeat(257) };
    const { exitCode, errorLine } = expectFatalExit(env);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(errorLine) as Record<string, unknown>;
    expect(parsed.variable).toBe('AGENT_SECRET');
    expect(parsed.message).toBe('length 257');
  });

  it('rejects missing AGENT_SECRET', () => {
    const env = { ...validEnv() };
    delete env.AGENT_SECRET;
    const { exitCode, errorLine } = expectFatalExit(env);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(errorLine) as Record<string, unknown>;
    expect(parsed.variable).toBe('AGENT_SECRET');
  });
});

describe('config.ts — TLS enabled without cert', () => {
  it('rejects TLS enabled with missing RELAY_TLS_CERT', () => {
    const env = { ...validEnv(), RELAY_TLS_ENABLED: 'true' };
    const { exitCode, errorLine } = expectFatalExit(env);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(errorLine) as Record<string, unknown>;
    expect(parsed.variable).toBe('RELAY_TLS_CERT');
  });

  it('rejects TLS enabled with cert but missing RELAY_TLS_KEY', () => {
    const env = {
      ...validEnv(),
      RELAY_TLS_ENABLED: 'true',
      RELAY_TLS_CERT: '/tmp/cert.pem',
    };
    const readFileSync = (_p: string): Buffer => Buffer.from('CERT');
    const { exitCode, errorLine } = expectFatalExit(env);
    // Without readFileSync override, it will fail on RELAY_TLS_CERT or KEY
    // depending on order. Let's test with the override:
    let exitCode2 = -1;
    let errorLine2 = '';
    try {
      loadConfig(env, {
        readFileSync,
        exit: ((code: number): never => {
          exitCode2 = code;
          throw new Error(`EXIT_${code}`);
        }) as (code: number) => never,
        stderr: (line: string): void => { errorLine2 = line; },
      });
    } catch {
      // expected
    }
    expect(exitCode2).toBe(1);
    const parsed = JSON.parse(errorLine2) as Record<string, unknown>;
    expect(parsed.variable).toBe('RELAY_TLS_KEY');
  });

  it('rejects TLS enabled with unreadable cert file', () => {
    const env = {
      ...validEnv(),
      RELAY_TLS_ENABLED: 'true',
      RELAY_TLS_CERT: '/nonexistent/cert.pem',
      RELAY_TLS_KEY: '/nonexistent/key.pem',
    };
    const readFileSync = (p: string): Buffer => {
      throw new Error(`ENOENT: no such file: ${p}`);
    };
    let exitCode2 = -1;
    let errorLine2 = '';
    try {
      loadConfig(env, {
        readFileSync,
        exit: ((code: number): never => {
          exitCode2 = code;
          throw new Error(`EXIT_${code}`);
        }) as (code: number) => never,
        stderr: (line: string): void => { errorLine2 = line; },
      });
    } catch {
      // expected
    }
    expect(exitCode2).toBe(1);
    const parsed = JSON.parse(errorLine2) as Record<string, unknown>;
    expect(parsed.variable).toBe('RELAY_TLS_CERT');
    expect((parsed.message as string)).toContain('read failed');
  });
});

describe('config.ts — invalid QUEUE_MAX_DEPTH', () => {
  it('rejects QUEUE_MAX_DEPTH = 50 (below 100)', () => {
    const env = { ...validEnv(), QUEUE_MAX_DEPTH: '50' };
    const { exitCode, errorLine } = expectFatalExit(env);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(errorLine) as Record<string, unknown>;
    expect(parsed.variable).toBe('QUEUE_MAX_DEPTH');
    expect(parsed.rule).toBe('integer in [100, 100000]');
  });

  it('rejects QUEUE_MAX_DEPTH = 200000 (above 100000)', () => {
    const env = { ...validEnv(), QUEUE_MAX_DEPTH: '200000' };
    const { exitCode, errorLine } = expectFatalExit(env);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(errorLine) as Record<string, unknown>;
    expect(parsed.variable).toBe('QUEUE_MAX_DEPTH');
  });

  it('rejects QUEUE_MAX_DEPTH = "notanumber"', () => {
    const env = { ...validEnv(), QUEUE_MAX_DEPTH: 'notanumber' };
    const { exitCode, errorLine } = expectFatalExit(env);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(errorLine) as Record<string, unknown>;
    expect(parsed.variable).toBe('QUEUE_MAX_DEPTH');
  });
});

describe('config.ts — valid config succeeds', () => {
  it('returns a valid RelayConfig for correct env', () => {
    const config = loadConfig(validEnv(), {
      exit: ((code: number): never => { throw new Error(`EXIT_${code}`); }) as (code: number) => never,
      stderr: () => {},
    });
    expect(config.port).toBe(3001);
    expect(config.kiroSecret).toBe('a-valid-secret-16ch');
    expect(config.agentSecret).toBe('another-valid-16ch!');
    expect(config.tls).toEqual({ enabled: false });
    expect(config.queueMaxDepth).toBe(1000);
  });
});
