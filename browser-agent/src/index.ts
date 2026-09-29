/**
 * Browser Agent boot orchestrator (Phase 2: multi-agent supervisor).
 *
 * The heavy lifting lives in {@link createWorkerPool}: one Chromium
 * process hosts N worker tabs, each with its own FSM, auth poller, and
 * relay socket — so the relay's dispatcher sees N independent agents and
 * parallelises dispatch across tabs. This file owns only the
 * cross-cutting lifecycle: config load, pool launch, SIGTERM/SIGINT
 * shutdown with a force-kill guard for hung Chromium closes.
 *
 * Implements:
 *   - R8.1   Chromium under puppeteer-extra+stealth (inside the pool).
 *   - R11.1  exponential relay reconnect (inside each worker's client).
 *   - R11.4  chromium disconnect → FSM `restarting` → pool relaunch.
 *   - R11.7  bounded relaunch attempts (≤ 4) inside the pool.
 *
 * @packageDocumentation
 */

import { loadConfig } from './config.js';
import { logAgentEvent } from './log/logger.js';
import { createWorkerPool, forceKillChromium } from './workers.js';

/**
 * Agent semver broadcast to the relay in every worker's handshake. Bumped
 * in lockstep with `browser-agent/package.json`.
 */
const AGENT_VERSION = '2.0.0';

/**
 * Bring the agent up. Loads config, launches the worker pool, and
 * installs SIGTERM / SIGINT shutdown hooks. Resolves once every worker's
 * relay client has registered for the first time; the process then stays
 * alive on the socket / Chromium event loops until a signal arrives.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  logAgentEvent({
    eventType: 'agent.config_loaded',
    workers: config.workerCount,
    typingMode: config.typingMode,
    stabilizationQuietMs: config.stabilizationQuietMs,
  });

  const pool = createWorkerPool({
    config,
    agentVersion: AGENT_VERSION,
    workerCount: config.workerCount,
    hooks: {
      onPoolReady: (count) => {
        logAgentEvent({ eventType: 'agent.boot', version: AGENT_VERSION, workers: count });
      },
      onWorkerStatus: (worker, status) => {
        logAgentEvent({
          eventType: status === 'ready' ? 'agent.ready' : 'agent.login_required',
          worker,
        });
      },
    },
  });

  await pool.launch();

  /**
   * Cooperative shutdown handler shared by SIGTERM and SIGINT. Stops the
   * pool (relay sockets first, then Chromium) and exits 0 so a
   * supervisor sees a clean stop.
   *
   * Force-kills the Chromium process tree if the graceful close hangs —
   * Chromium can hang on close when the WebSocket transport has been
   * pre-emptively torn down, leaving orphaned `chrome.exe` processes
   * (and ~30 worker processes) behind on Windows.
   */
  const shutdown = (signal: NodeJS.Signals): void => {
    logAgentEvent({ eventType: 'agent.error', errorCategory: 'shutdown', signal });
    void pool.stop();

    let exited = false;
    const finishExit = (): void => {
      if (exited) return;
      exited = true;
      process.exit(0);
    };

    // Hard ceiling: do not let a hung Chromium close keep the terminal
    // open forever. The pool's own stop() force-kills after 3 s; this
    // 6 s ceiling catches a wedged pool.stop() promise itself.
    setTimeout(finishExit, 6_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e: unknown) => {
  logAgentEvent({
    eventType: 'agent.error',
    errorCategory: 'boot_unhandled',
    error: String(e),
  });
  process.exit(1);
});
