/**
 * Browser Agent boot orchestrator.
 *
 * Wires every module of the agent into one process: config → logger →
 * state machine → Chromium → ChatGPT_Pro page → relay socket. Owns the
 * cross-cutting lifecycle concerns (chromium-disconnect → restart loop,
 * SIGTERM / SIGINT shutdown, in-flight tracking for cancel) and routes
 * dispatch payloads to the correct driver (chat vs image).
 *
 * Implements:
 *   - R8.1   bring up Chromium under puppeteer-extra+stealth on boot.
 *   - R8.10  cross-platform: delegated entirely to the chromium wrapper;
 *            this file contributes no platform-conditional code.
 *   - R11.1  exponential reconnect to the relay handled inside
 *            {@link createRelayClient}; this file just kicks it off.
 *   - R11.4  chromium `disconnected` → FSM `restarting` → relaunch.
 *   - R11.7  bounded relaunch attempts (≤ 4 retries) before giving up.
 *
 * Why dispatch + cancel handlers are registered BEFORE
 * `relayClient.start()` resolves: socket.io delivers the first
 * `agent.dispatch` immediately after `agent.register`, and we want zero
 * race window in which a packet arrives before its listener is attached.
 *
 * Why the FSM transitions are wrapped in try/catch: race conditions
 * between the chromium-disconnect path and the dispatch handler can
 * produce illegal sequences (e.g. a `busy → restarting` followed by a
 * stale `busy → ready` from the dispatch finally-block). We log the
 * illegal transition and keep the process alive — the FSM's structured
 * `agent.error` log entry preserves observability without crashing the
 * agent.
 *
 * @packageDocumentation
 */

import type { Browser, Page } from 'puppeteer';
import type {
  Request,
  CancelSignal,
  RequestId,
  ErrorCode,
} from '@kiro-gpt-bridge/shared';

import { loadConfig } from './config.js';
import { logAgentEvent } from './log/logger.js';
import { createAgentStateMachine } from './state/machine.js';
import { launchChromium } from './browser/chromium.js';
import {
  detectAuthState,
  startAuthPoller,
  type AuthPoller,
  type AuthState,
} from './browser/authDetector.js';
import { typeAndSubmitChat } from './browser/chatDriver.js';
import { extractStream } from './browser/streamExtractor.js';
import { generateImage, type ImageDriverPage } from './browser/imageDriver.js';
import {
  performStopAction,
  buildCancelledChunk,
} from './browser/stopAction.js';
import { createRelayClient } from './socket/relayClient.js';

/**
 * Semver string broadcast to the relay in the agent handshake. Bumped
 * in lockstep with `browser-agent/package.json`.
 */
const AGENT_VERSION = '0.0.0';

/**
 * Landing URL for ChatGPT_Pro. Hard-coded because the agent is
 * single-purpose; if we ever support a different instance, this will
 * become a config value.
 */
const CHATGPT_URL = 'https://chat.openai.com/';

/**
 * Soft cap on chromium relaunch attempts before we stop self-healing
 * (R11.7). The FSM's own counter increments per attempt and we compare
 * against this ceiling so the wrapper does not enter an infinite loop
 * when Chromium is fundamentally broken on the host (missing binary,
 * permission denied on `userDataDir`, etc.).
 */
const MAX_RELAUNCH_ATTEMPTS = 4;

/**
 * Goto budget for the initial ChatGPT navigation. We do not block
 * indefinitely: a wedged DNS / TLS handshake should surface as a
 * launch failure, get logged, and trigger the relaunch path.
 */
const NAVIGATION_TIMEOUT_MS = 60_000;

/**
 * Tracking entry for an in-flight dispatched request. The `abort`
 * callback flips a closure-scoped boolean inside the dispatch handler
 * so the chat-streaming loop can terminate early on cancel.
 *
 * Image generation does not have a built-in abort hook (the page-side
 * `fetch` cannot be cancelled cleanly mid-flight), so for image
 * requests the dispatch handler instead emits a final `cancelled`
 * chunk after the in-page work resolves.
 */
interface InflightEntry {
  /** Trip the cancel flag for this request. Idempotent. */
  abort(): void;
}

/**
 * Bring the agent up. Loads config, launches Chromium, connects to the
 * relay, registers dispatch / cancel handlers, and installs SIGTERM /
 * SIGINT shutdown hooks. Resolves once the relay client has registered
 * for the first time; the process then stays alive on the socket /
 * Chromium event loops until a signal arrives.
 *
 * Implements R8.1, R8.10, R11.1, R11.4, R11.7.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  logAgentEvent({ eventType: 'agent.config_loaded' });

  const fsm = createAgentStateMachine();

  // Mutable Chromium / page handles. `null` while a launch is in flight
  // or after a disconnect. Guards in the dispatch / cancel handlers
  // reject work that arrives during a restart window.
  let browser: Browser | null = null;
  let page: Page | null = null;
  let activePoller: AuthPoller | null = null;

  /**
   * Map of request-id → in-flight tracking entry. Used by the cancel
   * handler to flip the per-request abort flag without coupling the
   * dispatch and cancel paths through shared module state.
   */
  const inflight = new Map<RequestId, InflightEntry>();

  // Build the relay client up-front so the chromium-launch path can
  // call `relayClient.emitStatus(...)` once the page is ready.
  const relayClient = createRelayClient({ config, agentVersion: AGENT_VERSION });

  /**
   * Try to drive the FSM through `next` with the supplied reason.
   * Illegal transitions are swallowed (the FSM logs them as
   * `illegal_state_transition` errors) so a race between the chromium-
   * disconnect callback and a dispatch finally-block does not crash
   * the agent.
   */
  function safeTransition(
    next: Parameters<typeof fsm.transition>[0],
    reason: Parameters<typeof fsm.transition>[1],
  ): void {
    try {
      fsm.transition(next, reason);
    } catch {
      /* logged by fsm.transition; keep going. */
    }
  }

  /**
   * React to a fresh auth observation from the background poller. Only
   * acts on definite `ready` ↔ `login_required` flips originating from
   * `ready` or `login_required` — `unknown` is ignored (the next tick
   * will resolve the ambiguity) and `busy` is left alone so R8.7's
   * "only after current request finishes" rule is honoured.
   */
  function handleAuthChange(state: AuthState): void {
    const current = fsm.state();
    if (state === 'ready' && (current === 'login_required' || current === 'booting')) {
      // `booting -> ready` covers the common case where the persistent
      // profile already has a valid ChatGPT session — initial detection
      // can land on `unknown` (mid-redirect) and the first poller tick
      // is what confirms `ready`. Without this fan-in the FSM would be
      // stuck in `booting` forever and dispatches would be rejected
      // with `agent state booting` (CHATGPT_UNAVAILABLE).
      safeTransition('ready', 'auth_ready');
      relayClient.emitStatus('ready');
    } else if (state === 'login_required' && current === 'ready') {
      safeTransition('login_required', 'auth_lost');
      relayClient.emitStatus('login_required');
    }
  }

  /**
   * Launch (or relaunch) Chromium, navigate to ChatGPT_Pro, classify
   * the auth state, and start the background auth poller. On exit the
   * `browser` / `page` / `activePoller` closure variables are populated
   * and the FSM has been advanced out of `booting` (or `restarting`).
   *
   * Throws on launch / navigation failure; the caller decides whether
   * to retry via {@link relaunchChromium}.
   */
  async function launchAndPrepare(): Promise<void> {
    // Stop any stale poller from a previous page before we orphan it.
    activePoller?.stop();
    activePoller = null;

    const launched = await launchChromium({
      userDataDir: config.profileDir,
      onDisconnected: onChromiumDisconnected,
    });
    browser = launched;

    const pages = await launched.pages();
    const firstPage = pages[0] ?? (await launched.newPage());
    page = firstPage;

    await firstPage.goto(CHATGPT_URL, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    const initialAuth = await detectAuthState(firstPage);
    if (initialAuth === 'login_required') {
      safeTransition('login_required', 'auth_required');
      relayClient.emitStatus(
        'login_required',
        'please log in to ChatGPT in the open browser window',
      );
    } else if (initialAuth === 'ready') {
      safeTransition('ready', 'auth_ready');
      relayClient.emitStatus('ready');
    }
    // `unknown` deliberately falls through: the poller below will fire
    // its first observation almost immediately and drive the FSM then.

    activePoller = startAuthPoller(firstPage, handleAuthChange);
  }

  /**
   * Fired by `puppeteer.Browser`'s `disconnected` event (R11.4). Trips
   * the FSM to `restarting` and schedules a relaunch. The handler
   * itself stays sync — the relaunch chain runs in the background.
   */
  function onChromiumDisconnected(): void {
    logAgentEvent({
      eventType: 'agent.error',
      errorCategory: 'chromium_disconnected',
    });
    safeTransition('restarting', 'chromium_crash');
    relayClient.emitStatus('restarting', 'chromium disconnected');
    void relaunchChromium();
  }

  /**
   * Self-healing relaunch loop (R11.4 + R11.7). Each call increments
   * the FSM's relaunch counter and bails when it exceeds
   * {@link MAX_RELAUNCH_ATTEMPTS}; on success the counter is reset so
   * a future disconnect gets a fresh budget.
   */
  async function relaunchChromium(): Promise<void> {
    const attempt = fsm.incrementRelaunchAttempts();
    if (attempt > MAX_RELAUNCH_ATTEMPTS) {
      logAgentEvent({
        eventType: 'agent.error',
        errorCategory: 'chromium_relaunch_exhausted',
        attempt,
      });
      return;
    }
    try {
      await launchAndPrepare();
      fsm.resetRelaunchAttempts();
    } catch (e) {
      logAgentEvent({
        eventType: 'agent.error',
        errorCategory: 'chromium_relaunch_failed',
        attempt,
        error: String(e),
      });
      void relaunchChromium();
    }
  }

  /**
   * Handle one inbound `agent.dispatch`. Routes to the chat or image
   * driver, streams chunks back through the relay client, and tracks
   * the request in {@link inflight} so {@link onCancel} can flip its
   * abort flag.
   *
   * The `aborted` flag is the cancellation join point: the chat loop
   * checks it after each chunk; the image path lets the in-page work
   * complete and then emits a final cancelled chunk if the flag was
   * tripped.
   */
  async function onDispatch(request: Request): Promise<void> {
    if (fsm.state() !== 'ready' || page === null) {
      relayClient.emitFailure(
        request.requestId,
        'CHATGPT_UNAVAILABLE',
        `agent state ${fsm.state()}`,
      );
      return;
    }

    const livePage: Page = page;
    safeTransition('busy', 'dispatch_received');
    relayClient.emitAck(request.requestId);

    let aborted = false;
    inflight.set(request.requestId, {
      abort: (): void => {
        aborted = true;
      },
    });

    try {
      if (request.type === 'image') {
        // The structural `ImageDriverPage` declares an optional `goto`
        // with a wider `waitUntil: string` than puppeteer's enum, which
        // makes the puppeteer `Page` non-assignable by structural rules
        // even though the driver only invokes `goto` defensively. We
        // narrow via an `unknown` hop instead of polluting the driver's
        // surface with puppeteer's exact lifecycle enum.
        const imagePage = livePage as unknown as ImageDriverPage;
        const result = await generateImage(
          imagePage,
          request.prompt,
          request.requestId,
        );
        if (aborted) {
          relayClient.emitChunk(buildCancelledChunk(request.requestId, '', 0));
        } else if (result.ok) {
          relayClient.emitChunk({
            protocolVersion: 1,
            requestId: request.requestId,
            chunkIndex: 0,
            text: '',
            isFinal: true,
            mediaType: result.mediaType,
            base64: result.base64,
          });
        } else {
          relayClient.emitFailure(
            request.requestId,
            result.errorCode,
            result.message,
          );
        }
      } else {
        const submission = await typeAndSubmitChat(
          livePage,
          request.prompt,
          request.requestId,
        );
        if (!submission.ok) {
          const code: ErrorCode = submission.errorCode ?? 'CHATGPT_UNAVAILABLE';
          relayClient.emitFailure(request.requestId, code, submission.message);
        } else {
          let earlyExit = false;
          for await (const event of extractStream(livePage, request.requestId)) {
            if (aborted) {
              earlyExit = true;
              break;
            }
            if (event.kind === 'chunk' || event.kind === 'final') {
              relayClient.emitChunk(event.chunk);
            } else {
              relayClient.emitFailure(
                request.requestId,
                event.errorCode,
                event.message,
              );
              earlyExit = true;
              break;
            }
          }
          if (aborted) {
            // Cancellation interrupted mid-stream. The stop-action
            // handler clicked Stop on the page; emit a final chunk so
            // the relay can fan a terminal `cancelled` to the client.
            relayClient.emitChunk(
              buildCancelledChunk(request.requestId, '', 0),
            );
          }
          // `earlyExit` is captured so future maintainers can hook
          // post-stream cleanup here without re-deriving the bit.
          void earlyExit;
        }
      }
    } catch (e) {
      logAgentEvent({
        eventType: 'agent.error',
        errorCategory: 'dispatch_handler',
        requestId: request.requestId,
        error: String(e),
      });
      relayClient.emitFailure(
        request.requestId,
        'CHATGPT_UNAVAILABLE',
        String(e),
      );
    } finally {
      inflight.delete(request.requestId);
      // The FSM may already be back in `ready` (e.g. if a chromium
      // crash mid-dispatch tripped the `restarting` path); the safe
      // transition swallows the illegal `restarting → ready` attempt.
      safeTransition('ready', 'response_final');
    }
  }

  /**
   * Handle one inbound `agent.cancel`. Trips the in-flight abort flag
   * and drives ChatGPT's Stop action on the page. Failures of the
   * page-side stop are logged but not re-raised — the abort flag has
   * already been set, so the dispatch handler will short-circuit on
   * its next chunk poll regardless.
   */
  async function onCancel(cancel: CancelSignal): Promise<void> {
    const entry = inflight.get(cancel.requestId);
    if (entry !== undefined) {
      entry.abort();
    }
    if (page === null) return;
    try {
      await performStopAction(page);
      logAgentEvent({
        eventType: 'agent.cancel_executed',
        requestId: cancel.requestId,
      });
    } catch (e) {
      logAgentEvent({
        eventType: 'agent.error',
        errorCategory: 'cancel_executed',
        requestId: cancel.requestId,
        error: String(e),
      });
    }
  }

  // Register handlers BEFORE `relayClient.start()` so the very first
  // dispatch arriving on register cannot race the listener attach.
  relayClient.onDispatch((req: Request): void => {
    void onDispatch(req);
  });
  relayClient.onCancel((cancel: CancelSignal): void => {
    void onCancel(cancel);
  });

  await launchAndPrepare();
  await relayClient.start();
  logAgentEvent({ eventType: 'agent.boot', version: AGENT_VERSION });

  /**
   * Cooperative shutdown handler shared by SIGTERM and SIGINT. Closes
   * the relay socket, tears down Chromium best-effort, and exits 0 so
   * a supervisor (systemd, pm2, container runtime) sees a clean stop.
   *
   * Force-kills the Chromium browser process and its child render
   * processes if `browser.close()` does not return within 3 seconds —
   * Chromium can hang on close when the WebSocket transport has been
   * pre-emptively torn down by the relay disconnect, leaving an
   * orphaned `chrome.exe` (and ~30 worker processes) behind on
   * Windows. The forced-kill path matches what Chrome's own
   * task-manager does on a hard quit.
   */
  const shutdown = (signal: NodeJS.Signals): void => {
    logAgentEvent({ eventType: 'agent.error', errorCategory: 'shutdown', signal });
    activePoller?.stop();
    relayClient.stop();

    const captured = browser;
    if (captured !== null) {
      let exited = false;
      const finishExit = (): void => {
        if (exited) return;
        exited = true;
        process.exit(0);
      };

      // Best-effort graceful close.
      captured.close().catch(() => {
        /* fall through to forced kill */
      });

      // 3-second guard: if `close()` has not torn down Chromium, kill
      // the underlying process tree.
      setTimeout((): void => {
        try {
          // puppeteer exposes the spawned Chromium pid via .process()
          const proc =
            (captured as unknown as { process(): { pid?: number } | null }).process?.() ?? null;
          const pid = proc?.pid;
          if (typeof pid === 'number' && pid > 0) {
            if (process.platform === 'win32') {
              // /T = also kill child processes; /F = forced.
              const cp = require('node:child_process') as typeof import('node:child_process');
              cp.spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
                detached: true,
                stdio: 'ignore',
              }).unref();
            } else {
              try {
                process.kill(-pid, 'SIGKILL');
              } catch {
                try {
                  process.kill(pid, 'SIGKILL');
                } catch {
                  /* already gone */
                }
              }
            }
          }
        } catch {
          /* best-effort cleanup */
        }
        finishExit();
      }, 3_000).unref();

      // Hard ceiling: even if taskkill is slow, do not let the agent
      // hang the terminal forever.
      setTimeout(finishExit, 6_000).unref();
      return;
    }

    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e: unknown) => {
  logAgentEvent({
    eventType: 'agent.error',
    errorCategory: 'boot_unhandled',
    error: String(e),
  });
  process.exit(1);
});
