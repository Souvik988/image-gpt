/**
 * Validated, immutable runtime configuration for the relay-server.
 *
 * Built from environment variables once at boot via {@link loadConfig}.
 * On any invalid value the loader emits a structured JSON error line to
 * stderr and calls `process.exit(1)` — the relay must NOT start in a
 * misconfigured state. The function never throws on bad config; tests
 * inject `deps.exit` to observe the exit code without killing the runner.
 *
 * Implements R1.1, R1.2 (PORT bounds + fatal-on-bad-PORT),
 * R2.4 (TLS env group), R2.5 (secret bounds), R6.5 (queue max depth).
 */

import * as fs from 'node:fs';

/**
 * Validated relay-server configuration. Built from env vars at startup;
 * invalid values cause `process.exit(1)` with a structured stderr log
 * before this object is ever produced.
 */
export interface RelayConfig {
  /** TCP listen port, integer in [1, 65535]. Default 3001. (R1.1, R1.2) */
  port: number;
  /** Shared secret presented by KIRO clients, length in [16, 256]. (R2.5) */
  kiroSecret: string;
  /** Shared secret presented by browser agents, length in [16, 256]. (R2.5) */
  agentSecret: string;
  /**
   * TLS material discriminated by `enabled`. When `enabled` is `true` the
   * cert/key buffers are pre-read so the server can hand them straight to
   * `https.createServer({ cert, key })`. (R2.4)
   */
  tls:
    | { enabled: false }
    | {
        enabled: true;
        certPath: string;
        keyPath: string;
        cert: Buffer;
        key: Buffer;
      };
  /** Pending-queue max depth, integer in [100, 100000]. Default 1000. (R6.5) */
  queueMaxDepth: number;
}

/**
 * Test-injection seam. All three hooks default to the real
 * implementations (`fs.readFileSync`, `process.exit`, `console.error`).
 * Unit tests in task 4.5 pass stubs to verify exit-code behavior without
 * touching the real filesystem or terminating the test runner.
 */
export interface ConfigDeps {
  /** Override for `fs.readFileSync` used to load TLS material. */
  readFileSync?: (p: string) => Buffer;
  /** Override for `process.exit`. Tests typically throw here. */
  exit?: (code: number) => never;
  /** Override sink for the single-line structured error log. */
  stderr?: (line: string) => void;
}

/**
 * Internal shape passed to {@link fatal}. The three required fields are
 * spread into the emitted JSON line alongside `timestamp`, `level`, and
 * `event`.
 */
interface ConfigError {
  variable: string;
  rule: string;
  message: string;
}

/** {@link ConfigDeps} with every hook resolved to a concrete function. */
type ResolvedDeps = Required<ConfigDeps>;

/**
 * Resolve user-supplied {@link ConfigDeps} against real Node defaults.
 * `fs.readFileSync` is wrapped because its overloaded type signature does
 * not satisfy `(p: string) => Buffer` directly without an explicit binding.
 */
function resolveDeps(deps: ConfigDeps): ResolvedDeps {
  return {
    readFileSync: deps.readFileSync ?? ((p: string): Buffer => fs.readFileSync(p)),
    exit: deps.exit ?? (process.exit as (code: number) => never),
    // eslint-disable-next-line no-console -- structured JSON to stderr is the design pattern for boot-time config failures (R1.2, R2.5); the relay logger is not yet initialized at this point in the lifecycle
    stderr: deps.stderr ?? ((line: string): void => console.error(line)),
  };
}

/**
 * Emit the structured `config.invalid` line and exit the process.
 *
 * Output shape:
 * ```
 * {"timestamp":"<ISO8601>","level":"error","event":"config.invalid",
 *  "variable":"PORT","rule":"integer in [1, 65535]","message":"got \"70000\""}
 * ```
 *
 * Always returns `never`: the default `exit` is `process.exit(1)`; the
 * test stub throws. Implements R1.2, R2.4, R2.5, R6.5.
 */
function fatal(err: ConfigError, deps: ResolvedDeps): never {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'error',
    event: 'config.invalid',
    variable: err.variable,
    rule: err.rule,
    message: err.message,
  });
  deps.stderr(line);
  return deps.exit(1);
}

/**
 * Parse and validate an integer-typed env var. Calls {@link fatal} on
 * any value that is not a finite integer in `[min, max]`.
 *
 * Implements R1.1, R1.2 (PORT) and R6.5 (QUEUE_MAX_DEPTH).
 */
function parseInteger(
  name: string,
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
  deps: ResolvedDeps,
): number {
  const val = raw === undefined ? defaultValue : Number(raw);
  if (!Number.isInteger(val) || val < min || val > max) {
    fatal(
      {
        variable: name,
        rule: `integer in [${min}, ${max}]`,
        message: `got ${JSON.stringify(raw)}`,
      },
      deps,
    );
  }
  return val;
}

/**
 * Parse and validate one of the two shared secrets. Calls {@link fatal}
 * when the value is missing or not a string of length in [16, 256].
 *
 * The raw secret bytes are NEVER included in the error message — only
 * `unset` or `length N` is reported. Implements R2.5.
 */
function parseSecret(
  name: string,
  raw: string | undefined,
  deps: ResolvedDeps,
): string {
  if (typeof raw !== 'string' || raw.length < 16 || raw.length > 256) {
    fatal(
      {
        variable: name,
        rule: 'string length in [16, 256]',
        message: raw === undefined ? 'unset' : `length ${raw.length}`,
      },
      deps,
    );
  }
  return raw;
}

/**
 * Parse the TLS env group. Reads cert/key bytes synchronously when TLS
 * is enabled (boot-time, single shot). Surfaces missing paths and read
 * failures as structured config errors. Implements R2.4.
 */
function parseTls(
  env: NodeJS.ProcessEnv,
  deps: ResolvedDeps,
): RelayConfig['tls'] {
  const flag = env.RELAY_TLS_ENABLED ?? 'false';
  if (flag !== 'true' && flag !== 'false') {
    fatal(
      {
        variable: 'RELAY_TLS_ENABLED',
        rule: 'one of "true" | "false"',
        message: `got ${JSON.stringify(flag)}`,
      },
      deps,
    );
  }
  if (flag === 'false') {
    return { enabled: false };
  }

  const certPath = env.RELAY_TLS_CERT;
  const keyPath = env.RELAY_TLS_KEY;
  if (certPath === undefined || certPath === '') {
    fatal(
      {
        variable: 'RELAY_TLS_CERT',
        rule: 'required when RELAY_TLS_ENABLED=true',
        message: 'unset',
      },
      deps,
    );
  }
  if (keyPath === undefined || keyPath === '') {
    fatal(
      {
        variable: 'RELAY_TLS_KEY',
        rule: 'required when RELAY_TLS_ENABLED=true',
        message: 'unset',
      },
      deps,
    );
  }

  let cert: Buffer;
  try {
    cert = deps.readFileSync(certPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fatal(
      {
        variable: 'RELAY_TLS_CERT',
        rule: 'readable PEM file',
        message: `read failed: ${msg}`,
      },
      deps,
    );
  }

  let key: Buffer;
  try {
    key = deps.readFileSync(keyPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fatal(
      {
        variable: 'RELAY_TLS_KEY',
        rule: 'readable PEM file',
        message: `read failed: ${msg}`,
      },
      deps,
    );
  }

  return {
    enabled: true,
    certPath,
    keyPath,
    cert,
    key,
  };
}

/**
 * Parse and validate environment variables. On any invalid value:
 *
 *   - emits a structured JSON line to `stderr` of the shape
 *     `{"timestamp":"<ISO8601>","level":"error","event":"config.invalid",
 *      "variable":"<NAME>","rule":"<RULE>","message":"<DETAIL>"}`
 *   - calls `process.exit(1)`
 *
 * Tests inject `deps` to substitute `fs.readFileSync`, `process.exit`,
 * and the stderr sink so exit-code behavior can be observed without
 * killing the runner.
 *
 * Implements R1.1, R1.2, R2.4, R2.5, R6.5.
 *
 * @param env Defaults to `process.env`. Pass an explicit object in tests.
 * @param deps Optional injection seam for the three I/O effects.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  deps: ConfigDeps = {},
): RelayConfig {
  const resolved = resolveDeps(deps);
  return {
    port: parseInteger('PORT', env.PORT, 3001, 1, 65535, resolved),
    kiroSecret: parseSecret('KIRO_SECRET', env.KIRO_SECRET, resolved),
    agentSecret: parseSecret('AGENT_SECRET', env.AGENT_SECRET, resolved),
    tls: parseTls(env, resolved),
    queueMaxDepth: parseInteger(
      'QUEUE_MAX_DEPTH',
      env.QUEUE_MAX_DEPTH,
      1000,
      100,
      100_000,
      resolved,
    ),
  };
}
