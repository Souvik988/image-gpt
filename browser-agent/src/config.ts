/**
 * Validated, immutable runtime configuration for the browser-agent.
 * Loaded once at boot via `loadConfig()`. On any invalid value the
 * function emits one structured JSON line to stderr and exits with a
 * non-zero status code: an agent must not start in a misconfigured
 * state.
 *
 * Mirrors the structural pattern of `relay-server/src/config.ts`:
 *   - fail-fast `fatal()` helper with injected `exit`/`stderr` for tests
 *   - one variable validated per function, in the order they appear in
 *     the requirements
 *   - structured error shape carries the variable name, the rule that
 *     was violated, and a human-readable message
 *
 * Implements R8.3 (persistent profile dir), R8.4 (validation rules),
 * R11.2 (Agent_Secret re-auth contract).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Validated, immutable runtime configuration for the browser-agent.
 *
 * Implements R8.3, R8.4, R11.2.
 */
export interface AgentConfig {
  /** Absolute, writable directory used as Chromium `userDataDir`. (R8.3, R8.4) */
  readonly profileDir: string;
  /** Relay Socket.IO URL. Protocol is one of `ws:`, `wss:`, `http:`, `https:`. */
  readonly relayUrl: string;
  /** Shared `Agent_Secret` (16..256 chars). Used for handshake and re-auth. (R11.2) */
  readonly agentSecret: string;
}

/**
 * Injectable side-effects so tests can drive `loadConfig` without
 * touching the real process or filesystem.
 *
 * - `exit`: replaces `process.exit`. Default exits with code 1.
 * - `stderr`: receives the already-serialized JSON line (without trailing
 *   newline). Default writes the line plus `"\n"` to `process.stderr`.
 * - `accessSync`: replaces `fs.accessSync`. Default delegates to the
 *   real `fs.accessSync`. Throwing indicates the path is not writable.
 */
export interface ConfigDeps {
  exit?: (code: number) => never;
  stderr?: (line: string) => void;
  accessSync?: (p: string, mode: number) => void;
}

/**
 * Emit one structured JSON error line to stderr and terminate the
 * process. Always returns `never` — TypeScript narrows callers
 * accordingly.
 *
 * The wire shape is stable: log consumers can match on
 * `event === 'config.invalid'` and `component === 'browser-agent'`.
 *
 * Implements the fatal-on-bad-config contract of R8.4 and R11.2.
 *
 * @param variable Offending environment variable name.
 * @param rule     Short label for the rule that was violated.
 * @param message  Human-readable detail (never the raw secret).
 * @param deps     Injectable `exit` / `stderr` for tests.
 */
function fatal(
  variable: string,
  rule: string,
  message: string,
  deps: ConfigDeps,
): never {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'error',
    event: 'config.invalid',
    component: 'browser-agent',
    variable,
    rule,
    message,
  });
  // Use process.stderr.write rather than console.error: no implicit
  // newlines or stdio buffering surprises across platforms.
  (deps.stderr ?? ((l: string): void => {
    process.stderr.write(l + '\n');
  }))(line);
  return (deps.exit ?? (process.exit as (code: number) => never))(1);
}

/**
 * Validate `AGENT_PROFILE_DIR`. Must be set, must be an absolute path,
 * and must pass an `fs.accessSync(path, W_OK)` writability probe (which
 * also implies the path exists).
 *
 * Implements R8.3, R8.4.
 */
function parseProfileDir(
  raw: string | undefined,
  deps: ConfigDeps,
): string {
  if (raw === undefined || raw === '') {
    fatal('AGENT_PROFILE_DIR', 'required', 'unset', deps);
  }
  if (!path.isAbsolute(raw)) {
    fatal(
      'AGENT_PROFILE_DIR',
      'absolute path',
      `got ${JSON.stringify(raw)}`,
      deps,
    );
  }
  try {
    (deps.accessSync ?? fs.accessSync)(raw, fs.constants.W_OK);
  } catch (e) {
    fatal(
      'AGENT_PROFILE_DIR',
      'existing writable directory',
      `access check failed: ${(e as Error).message}`,
      deps,
    );
  }
  return raw;
}

/**
 * Validate `RELAY_URL`. Must parse via `new URL(...)` and use one of
 * `ws:`, `wss:`, `http:`, `https:`. Returns the original string verbatim
 * — callers that need a `URL` object should re-parse downstream.
 *
 * Implements R11.2 (transport target for the agent socket client).
 */
function parseRelayUrl(
  raw: string | undefined,
  deps: ConfigDeps,
): string {
  if (raw === undefined || raw === '') {
    fatal('RELAY_URL', 'required', 'unset', deps);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (e) {
    fatal('RELAY_URL', 'valid URL', (e as Error).message, deps);
  }
  const allowed = ['ws:', 'wss:', 'http:', 'https:'];
  if (!allowed.includes(url.protocol)) {
    fatal(
      'RELAY_URL',
      'protocol in [ws:, wss:, http:, https:]',
      `got ${url.protocol}`,
      deps,
    );
  }
  return raw;
}

/**
 * Validate a string secret of length 16..256. The raw value is NEVER
 * placed in the error message — only its length is reported.
 *
 * Implements R11.2 (Agent_Secret bounds).
 *
 * @param name Variable name used for diagnostic output.
 */
function parseSecret(
  name: string,
  raw: string | undefined,
  deps: ConfigDeps,
): string {
  if (typeof raw !== 'string' || raw.length < 16 || raw.length > 256) {
    fatal(
      name,
      'string length in [16, 256]',
      raw === undefined ? 'unset' : `length ${raw.length}`,
      deps,
    );
  }
  return raw;
}

/**
 * Load and validate the browser-agent config from `env`. On any failure,
 * emit a single structured JSON line to stderr and exit with code 1.
 *
 * Validation order is fail-fast: `AGENT_PROFILE_DIR` → `RELAY_URL` →
 * `AGENT_SECRET`.
 *
 * Implements R8.3, R8.4, R11.2.
 *
 * @param env Defaults to `process.env`. Pass an explicit object in tests.
 * @param deps Defaults to `{}` (real `process.exit` / `process.stderr` /
 *   `fs.accessSync`). Tests inject stubs to capture failures.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  deps: ConfigDeps = {},
): AgentConfig {
  const profileDir = parseProfileDir(env.AGENT_PROFILE_DIR, deps);
  const relayUrl = parseRelayUrl(env.RELAY_URL, deps);
  const agentSecret = parseSecret('AGENT_SECRET', env.AGENT_SECRET, deps);
  return { profileDir, relayUrl, agentSecret };
}
