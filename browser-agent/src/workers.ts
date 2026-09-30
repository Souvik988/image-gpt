/**
 * Worker pool — the multi-agent execution core of the browser-agent.
 *
 * Phase 2 architecture: one Chromium process hosts N worker tabs. Every
 * worker owns:
 *   - its own `Page` (an independent ChatGPT conversation surface),
 *   - its own agent FSM (`state/machine.ts`),
 *   - its own auth poller,
 *   - its own relay socket connection (`createRelayClient` instance) and
 *     therefore its own relay-issued `agentId`.
 *
 * From the relay's point of view the pool is N independent agents. The
 * relay's dispatcher already implements idle-first / least-busy selection
 * and FIFO queueing, so dispatching a request to "worker 2 of 4" requires
 * no protocol change: each worker simply registers as an agent and
 * receives dispatches while idle. Batch workloads (icon sets, multi-asset
 * briefs) now parallelise across tabs automatically.
 *
 * Lifecycle:
 *   - `launch()` starts Chromium, opens N pages, navigates each to
 *     ChatGPT, classifies auth, and connects each worker's relay client.
 *   - A Chromium `disconnected` event tears every worker's FSM down to
 *     `restarting` and relaunches the whole pool (bounded retries).
 *   - `stop()` disconnects every relay client and closes Chromium.
 *
 * Concurrency notes:
 *   - All workers share one persistent Chromium profile, so a login in
 *     any tab authenticates every tab (same cookie jar). Each worker's
 *     auth poller still runs independently: the FSMs converge on
 *     `ready` / `login_required` per tab, and a per-tab interstitial
 *     (bot check, session refresh) never blocks the other workers.
 *   - Dispatches are handled per worker; the abort/cancel bookkeeping
 *     (in-flight maps) is worker-scoped.
 *
 * @packageDocumentation
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Browser, Page } from 'puppeteer';
import type {
  Request,
  CancelSignal,
  RequestId,
  ErrorCode,
} from '@kiro-gpt-bridge/shared';

import type { AgentConfig } from './config.js';
import { logAgentEvent } from './log/logger.js';
import { createAgentStateMachine, type AgentStateMachine } from './state/machine.js';
import { launchChromium } from './browser/chromium.js';
import {
  detectAuthState,
  detectAuthStateDetailed,
  startAuthPoller,
  type AuthPoller,
  type AuthState,
} from './browser/authDetector.js';
import { typeAndSubmitChat } from './browser/chatDriver.js';
import { captureBaseline, extractStream } from './browser/streamExtractor.js';
import { generateImageViaApi } from './browser/apiDriver.js';
import { generateImage, type ImageDriverPage } from './browser/imageDriver.js';
import {
  performStopAction,
  buildCancelledChunk,
} from './browser/stopAction.js';
import { tryPassCloudflare, isChallengeTitle } from './browser/cloudflare.js';
import { createRelayClient, type RelayClient } from './socket/relayClient.js';

/**
 * Landing URL for ChatGPT. `chatgpt.com` is the canonical host —
 * `chat.openai.com` 301-redirects here, costing a round-trip on every
 * (re)launch and on every new-chat navigation.
 */
const CHATGPT_URL = 'https://chatgpt.com/';

/**
 * Budget for the per-request new-chat navigation. A fresh chat keeps
 * conversations short (fast DOM, no cross-request context bleed) and
 * makes the stream baseline trivially correct. If navigation exceeds
 * this budget the request proceeds on the current page — the stream
 * baseline logic still handles multi-turn conversations correctly.
 */
const NEW_CHAT_NAVIGATION_TIMEOUT_MS = 20_000;

/** Navigation budget for initial per-worker page load. */
const WORKER_NAVIGATION_TIMEOUT_MS = 60_000;

/** Soft cap on pool relaunch attempts before self-healing stops (R11.7). */
const MAX_RELAUNCH_ATTEMPTS = 4;

/**
 * Dispatch-level hard deadlines. The drivers carry their own internal
 * deadlines (image 600 s, stream idle 120 s) but a CDP evaluate that
 * never settles (page navigated/crashed mid-call) would hang the driver
 * past them — a hung await never rejects, so the worker would stay
 * `busy` forever. These outer deadlines guarantee every dispatch ends
 * and frees its worker.
 */
const IMAGE_HARD_DEADLINE_MS = 660_000;
const CHAT_HARD_DEADLINE_MS = 900_000;

/**
 * Cross-platform shutdown helper: force-kill the Chromium process tree
 * when a graceful `browser.close()` hangs (Windows leaves orphaned
 * chrome.exe processes behind otherwise). Kept from the original
 * single-agent shutdown path.
 */
/** Map an API content-type to the wire-closed image MIME set. */
function normalizeApiMime(raw: string): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' {
  const lower = raw.toLowerCase().split(';')[0]?.trim() ?? '';
  if (lower === 'image/jpeg' || lower === 'image/jpg') return 'image/jpeg';
  if (lower === 'image/webp') return 'image/webp';
  if (lower === 'image/gif') return 'image/gif';
  return 'image/png';
}

export function forceKillChromium(browser: Browser): void {
  try {
    const proc =
      (browser as unknown as { process(): { pid?: number } | null }).process?.() ?? null;
    const pid = proc?.pid;
    if (typeof pid === 'number' && pid > 0) {
      if (process.platform === 'win32') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- shutdown path only
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
}

// ─── Worker ────────────────────────────────────────────────────────────────

/** One worker tab: page + FSM + relay socket + cancel bookkeeping. */
interface Worker {
  /** 0-based worker index (also used to build the relay agentId label). */
  index: number;
  /** The worker's own ChatGPT tab. */
  page: Page;
  /** Worker-scoped agent FSM. */
  fsm: AgentStateMachine;
  /** Background auth poller driving {@link fsm}. */
  poller: AuthPoller | null;
  /** Worker-scoped relay socket client (own agentId at the relay). */
  relay: RelayClient;
  /** Request-id → abort entry for in-flight work on this worker. */
  inflight: Map<RequestId, { abort(): void }>;
}

/** Observability hooks the pool emits so the host process can log. */
export interface WorkerPoolHooks {
  /** Called after every successful (re)launch of the full pool. */
  onPoolReady?: (workerCount: number) => void;
  /** Called when a worker's FSM reaches `ready` or `login_required`. */
  onWorkerStatus?: (workerIndex: number, status: 'ready' | 'login_required') => void;
}

/** Construction options for {@link createWorkerPool}. */
export interface WorkerPoolOptions {
  /** Validated agent runtime config. */
  config: AgentConfig;
  /** Agent semver sent in each worker's handshake. */
  agentVersion: string;
  /** Number of worker tabs to run. Clamped to 1..8 by config validation. */
  workerCount: number;
  /** Observability hooks. */
  hooks?: WorkerPoolHooks;
}

/** Public surface of the worker pool. */
export interface WorkerPool {
  /** Launch Chromium and all workers. Resolves when every relay client has registered. */
  launch(): Promise<void>;
  /** Graceful stop: disconnect relays, close Chromium. Idempotent. */
  stop(): Promise<void>;
  /** Number of configured workers. */
  workerCount(): number;
  /** Per-worker relay agentIds (for logging / diagnostics). */
  agentIds(): (string | null)[];
}

/**
 * Build the worker pool. See module docs for the architecture.
 */
export function createWorkerPool(opts: WorkerPoolOptions): WorkerPool {
  const { config, agentVersion } = opts;
  const workerCount = Math.max(1, Math.min(8, opts.workerCount));
  const hooks = opts.hooks ?? {};

  let browser: Browser | null = null;
  let workers: Worker[] = [];
  let relaunchAttempts = 0;
  let stopped = false;
  let launching: Promise<void> | null = null;

  // ─── FSM helper ─────────────────────────────────────────────────────────

  /**
   * Drive a worker's FSM through `next`, swallowing illegal transitions.
   * Races between chromium-disconnect and dispatch finally-blocks are
   * expected; the FSM logs them and the pool keeps going.
   */
  function safeTransition(
    fsm: AgentStateMachine,
    next: Parameters<AgentStateMachine['transition']>[0],
    reason: Parameters<AgentStateMachine['transition']>[1],
  ): void {
    try {
      fsm.transition(next, reason);
    } catch {
      /* logged by fsm.transition; keep going. */
    }
  }

  // ─── Auth handling (per worker) ─────────────────────────────────────────

  /**
   * React to a fresh auth observation for one worker. Only acts on
   * definite `ready` ↔ `login_required` flips — `unknown` is ignored
   * (the next tick resolves the ambiguity) and `busy` is left alone.
   */
  function handleAuthChange(worker: Worker, state: AuthState): void {
    const current = worker.fsm.state();
    if (state === 'ready' && (current === 'login_required' || current === 'booting')) {
      safeTransition(worker.fsm, 'ready', 'auth_ready');
      worker.relay.emitStatus('ready');
      hooks.onWorkerStatus?.(worker.index, 'ready');
    } else if (state === 'login_required' && current === 'ready') {
      safeTransition(worker.fsm, 'login_required', 'auth_lost');
      worker.relay.emitStatus('login_required');
      hooks.onWorkerStatus?.(worker.index, 'login_required');
    }
  }

  // ─── New chat navigation ────────────────────────────────────────────────

  /**
   * Navigate this worker's page to a fresh chat so each request starts
   * from an empty conversation. Best-effort.
   */
  async function navigateToNewChat(worker: Worker): Promise<void> {
    try {
      await worker.page.goto(CHATGPT_URL, {
        waitUntil: 'domcontentloaded',
        timeout: NEW_CHAT_NAVIGATION_TIMEOUT_MS,
      });
      if (isChallengeTitle(await worker.page.title().catch(() => ''))) {
        logAgentEvent({ eventType: 'agent.cloudflare', stage: 'challenge_detected', worker: worker.index, scope: 'new_chat' });
        const passed = await tryPassCloudflare(worker.page, { maxAttempts: 6 });
        logAgentEvent({ eventType: 'agent.cloudflare', stage: passed ? 'passed' : 'persisted', worker: worker.index, scope: 'new_chat' });
      }
      logAgentEvent({ eventType: 'agent.new_chat', worker: worker.index });
    } catch (e) {
      logAgentEvent({
        eventType: 'agent.error',
        errorCategory: 'new_chat_navigation_failed',
        worker: worker.index,
        error: String(e),
      });
    }
  }

  // ─── Dispatch (per worker) ──────────────────────────────────────────────

  /**
   * Handle one inbound `agent.dispatch` on `worker`. Routes to the chat
   * or image driver, streams chunks back through the worker's relay
   * client, and tracks the request in the worker's in-flight map so
   * {@link onCancel} can flip its abort flag.
   */
  async function onDispatch(worker: Worker, request: Request): Promise<void> {
    if (worker.fsm.state() !== 'ready') {
      worker.relay.emitFailure(
        request.requestId,
        'CHATGPT_UNAVAILABLE',
        `worker ${worker.index} state ${worker.fsm.state()}`,
      );
      return;
    }

    safeTransition(worker.fsm, 'busy', 'dispatch_received');
    worker.relay.emitAck(request.requestId);

    let aborted = false;
    let attachmentDir: string | null = null;
    worker.inflight.set(request.requestId, {
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
        const imagePage = worker.page as unknown as ImageDriverPage;
        // Expose puppeteer's real screenshot capability to the driver for
        // the rendered-mockup fallback (clip is in document CSS pixels).
        (imagePage as { screenshot?: unknown }).screenshot = async (opts: {
          clip?: { x: number; y: number; width: number; height: number };
        }): Promise<Uint8Array> => {
          const shot = await worker.page.screenshot({
            ...(opts.clip !== undefined ? { clip: opts.clip } : {}),
            captureBeyondViewport: true,
          });
          return new Uint8Array(shot);
        };
        // Decode request attachments to temp files and expose the
        // composer file-input upload to the driver (Phase 8 references).
        attachmentDir = path.join(
          os.tmpdir(),
          'kiro-gpt-attachments',
          request.requestId,
        );
        const attachmentFiles: Array<{ filename: string; path: string }> = [];
        if (request.attachments !== undefined && request.attachments.length > 0) {
          await fsp.mkdir(attachmentDir, { recursive: true });
          for (const att of request.attachments) {
            const safeName = att.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
            const filePath = path.join(attachmentDir, safeName);
            await fsp.writeFile(filePath, Buffer.from(att.base64, 'base64'));
            attachmentFiles.push({ filename: att.filename, path: filePath });
          }
        }
        (imagePage as { uploadFiles?: unknown }).uploadFiles = async (
          paths: string[],
        ): Promise<boolean> => {
          const inputs = await worker.page.$$('input[type="file"]');
          if (inputs.length === 0) return false;
          const handle = inputs[0];
          if (handle === null || handle === undefined) return false;
          await handle.uploadFile(...paths);
          return true;
        };
        const result = await Promise.race([
          (async () => {
            // Phase 8 anti-detection: prefer the same-origin API driver
            // (no DOM interaction). Fall back to the DOM driver when the
            // API contract drifts or the page is not signed in.
            if (config.imageViaApi) {
              const api = await generateImageViaApi(
                imagePage,
                request.prompt,
                request.requestId,
                { timeoutMs: 420_000 },
              );
              if (api.ok) {
                return {
                  ok: true as const,
                  mediaType: normalizeApiMime(api.mime),
                  base64: api.base64,
                };
              }
              logAgentEvent({
                eventType: 'agent.error',
                errorCategory: 'api_driver_fallback',
                requestId: request.requestId,
                code: api.code,
              });
            }
            return generateImage(imagePage, request.prompt, request.requestId, {
              stabilizationQuietMs: config.stabilizationQuietMs,
              attachments: attachmentFiles,
            });
          })(),
          new Promise<never>((_, reject) => {
            const t = setTimeout(
              () => reject(new Error('image hard deadline exceeded')),
              IMAGE_HARD_DEADLINE_MS,
            );
            t.unref?.();
          }),
        ]);
        if (aborted) {
          worker.relay.emitChunk(buildCancelledChunk(request.requestId, '', 0));
        } else if (result.ok) {
          worker.relay.emitChunk({
            protocolVersion: 1,
            requestId: request.requestId,
            chunkIndex: 0,
            text: '',
            isFinal: true,
            mediaType: result.mediaType,
            base64: result.base64,
          });
        } else {
          worker.relay.emitFailure(request.requestId, result.errorCode, result.message);
        }
      } else {
        const baseline = await Promise.race([
          captureBaseline(worker.page),
          new Promise<null>((resolve) => {
            const t = setTimeout(() => resolve(null), 30_000);
            t.unref?.();
          }),
        ]);
        if (baseline === null) {
          worker.relay.emitFailure(
            request.requestId,
            'CHATGPT_UNAVAILABLE',
            'conversation state unreadable before submit',
          );
          return;
        }
        const submission = await typeAndSubmitChat(worker.page, request.prompt, request.requestId, {
          mode: config.typingMode,
        });
        if (!submission.ok) {
          const code: ErrorCode = submission.errorCode ?? 'CHATGPT_UNAVAILABLE';
          worker.relay.emitFailure(request.requestId, code, submission.message);
        } else {
          // Hard deadline: a hung CDP await inside the extractor would
          // otherwise keep the worker busy forever. The consuming closure
          // races against a rejecting timer; on deadline the catch below
          // surfaces CHAT_TIMEOUT and the worker is freed.
          const streamDeadline = new Promise<never>((_, reject) => {
            const t = setTimeout(
              () => reject(new Error('chat hard deadline exceeded')),
              CHAT_HARD_DEADLINE_MS,
            );
            t.unref?.();
          });
          const consumeStream = async (): Promise<void> => {
            for await (const event of extractStream(worker.page, request.requestId, baseline, {
              idleTimeoutMs: config.streamIdleTimeoutMs,
              totalTimeoutMs: config.streamTotalTimeoutMs,
            })) {
              if (aborted) break;
              if (event.kind === 'chunk' || event.kind === 'final') {
                worker.relay.emitChunk(event.chunk);
              } else {
                worker.relay.emitFailure(request.requestId, event.errorCode, event.message);
                break;
              }
            }
          };
          await Promise.race([consumeStream(), streamDeadline]);
          if (aborted) {
            // Cancellation interrupted mid-stream; emit the terminal
            // cancelled chunk so the relay fans it to the client.
            worker.relay.emitChunk(buildCancelledChunk(request.requestId, '', 0));
          }
        }
      }
    } catch (e) {
      logAgentEvent({
        eventType: 'agent.error',
        errorCategory: 'dispatch_handler',
        worker: worker.index,
        requestId: request.requestId,
        error: String(e),
      });
      worker.relay.emitFailure(request.requestId, 'CHATGPT_UNAVAILABLE', String(e));
    } finally {
      if (attachmentDir !== null) {
        void fsp
          .rm(attachmentDir, { recursive: true, force: true })
          .catch(() => undefined);
      }
      worker.inflight.delete(request.requestId);
      // The FSM may already be back in `ready` (e.g. a chromium crash
      // mid-dispatch tripped the `restarting` path); the safe transition
      // swallows the illegal `restarting → ready` attempt.
      safeTransition(worker.fsm, 'ready', 'response_final');
    }
  }

  /**
   * Handle one inbound `agent.cancel` for `worker`. Trips the in-flight
   * abort flag and drives ChatGPT's Stop action on the worker's page.
   */
  async function onCancel(worker: Worker, cancel: CancelSignal): Promise<void> {
    const entry = worker.inflight.get(cancel.requestId);
    if (entry !== undefined) {
      entry.abort();
    }
    try {
      await performStopAction(worker.page);
      logAgentEvent({
        eventType: 'agent.cancel_executed',
        worker: worker.index,
        requestId: cancel.requestId,
      });
    } catch (e) {
      logAgentEvent({
        eventType: 'agent.error',
        errorCategory: 'cancel_executed',
        worker: worker.index,
        requestId: cancel.requestId,
        error: String(e),
      });
    }
  }

  // ─── Launch / relaunch ──────────────────────────────────────────────────

  /**
   * Bring one worker online on `page`: classify auth, start the poller,
   * wire the relay client, and connect. Resolves on registration.
   */
  async function launchWorker(browserRef: Browser, index: number): Promise<Worker> {
    const page = index === 0 ? await firstPageOf(browserRef) : await browserRef.newPage();
    await page.goto(CHATGPT_URL, {
      waitUntil: 'domcontentloaded',
      timeout: WORKER_NAVIGATION_TIMEOUT_MS,
    });

    // Cloudflare interstitial: fresh launches are commonly challenged.
    // Click the Turnstile checkbox (bounded attempts) before auth
    // detection — a stuck challenge page leaves the worker in `booting`
    // forever.
    for (let bootCheck = 0; bootCheck < 3; bootCheck += 1) {
      const title = await page.title().catch(() => '');
      if (!isChallengeTitle(title)) break;
      logAgentEvent({ eventType: 'agent.cloudflare', stage: 'challenge_detected', worker: index, scope: 'boot' });
      const passed = await tryPassCloudflare(page, { maxAttempts: 2, attemptDelayMs: 20_000 });
      logAgentEvent({ eventType: 'agent.cloudflare', stage: passed ? 'passed' : 'persisted', worker: index, scope: 'boot' });
      if (passed) break;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }

    const fsm = createAgentStateMachine();
    const worker: Worker = {
      index,
      page,
      fsm,
      poller: null,
      relay: createRelayClient({ config, agentVersion }),
      inflight: new Map(),
    };

    const initialAuth = await detectAuthState(page);
    if (initialAuth === 'login_required') {
      safeTransition(fsm, 'login_required', 'auth_required');
      worker.relay.emitStatus(
        'login_required',
        'please log in to ChatGPT in the open browser window',
      );
      hooks.onWorkerStatus?.(index, 'login_required');
    } else if (initialAuth === 'ready') {
      safeTransition(fsm, 'ready', 'auth_ready');
      worker.relay.emitStatus('ready');
      hooks.onWorkerStatus?.(index, 'ready');
    }
    // `unknown` deliberately falls through: the poller below fires its
    // first observation almost immediately and drives the FSM then.

    // Cloudflare challenges can appear AFTER boot (slow challenge load,
    // mid-session re-checks). Whenever the auth poller reports `unknown`
    // — neither composer nor login button visible — attempt the Turnstile
    // click, throttled so we never hammer the widget.
    let lastChallengeAttempt = 0;
    let challengeAttempts = 0;
    let unknownTicks = 0;
    worker.poller = startAuthPoller(page, (state) => {
      if (state === 'unknown') {
        unknownTicks += 1;
        if (unknownTicks % 3 === 1) {
          void detectAuthStateDetailed(page)
            .then((detail) =>
              page
                .evaluate((): {
                  title: string;
                  textareaCount: number;
                  contentEditableCount: number;
                  hasAskChatGPT: boolean;
                  bodyLen: number;
                } => ({
                  title: document.title,
                  textareaCount: document.querySelectorAll('textarea').length,
                  contentEditableCount: document.querySelectorAll('[contenteditable="true"]').length,
                  hasAskChatGPT: (document.body ? document.body.innerText : '').includes('Ask ChatGPT'),
                  bodyLen: document.body ? document.body.innerText.length : -1,
                }))
                .then((dom) => {
                  logAgentEvent({
                    eventType: 'agent.error',
                    errorCategory: 'auth_unknown_debug',
                    worker: index,
                    url: detail.url.slice(0, 120),
                    matchedInput: detail.matchedInput ?? null,
                    inputProbesRun: detail.inputProbesRun,
                    title: dom.title.slice(0, 80),
                    textareaCount: dom.textareaCount,
                    contentEditableCount: dom.contentEditableCount,
                    hasAskChatGPT: dom.hasAskChatGPT,
                    bodyLen: dom.bodyLen,
                  });
                })
                .catch((e: unknown) => {
                  logAgentEvent({
                    eventType: 'agent.error',
                    errorCategory: 'auth_unknown_debug',
                    worker: index,
                    evaluateFailed: String(e).slice(0, 200),
                  });
                }),
            )
            .catch(() => undefined);
        }
      } else {
        unknownTicks = 0;
      }
      if (state === 'unknown') {
        const nowMs = Date.now();
        // HUMAN-FIRST POLICY: at most TWO automated attempts per boot.
        // After that the Cloudflare checkbox belongs to the user.
        if (nowMs - lastChallengeAttempt > 45_000 && challengeAttempts < 2) {
          challengeAttempts += 1;
          lastChallengeAttempt = nowMs;
          void tryPassCloudflare(page, { maxAttempts: 1, attemptDelayMs: 1_000 })
            .then((passed) => {
              if (passed) {
                logAgentEvent({
                  eventType: 'agent.cloudflare',
                  stage: 'passed',
                  worker: index,
                  scope: 'poller',
                });
              }
            })
            .catch(() => undefined);
        }
      }
      handleAuthChange(worker, state);
    });

    // Register handlers BEFORE `relay.start()` so the very first dispatch
    // arriving on register cannot race the listener attach.
    worker.relay.onDispatch((req: Request): void => {
      void onDispatch(worker, req);
    });
    worker.relay.onCancel((cancel: CancelSignal): void => {
      void onCancel(worker, cancel);
    });

    await worker.relay.start();
    return worker;
  }

  /** The browser's initial tab (reused for worker 0). */
  async function firstPageOf(browserRef: Browser): Promise<Page> {
    const pages = await browserRef.pages();
    return pages[0] ?? (await browserRef.newPage());
  }

  /**
   * Launch Chromium and every worker. Concurrent calls coalesce onto a
   * single in-flight launch so a chromium-disconnect storm cannot spawn
   * duplicate pools.
   */
  async function launch(): Promise<void> {
    if (launching !== null) return launching;
    launching = (async (): Promise<void> => {
      relaunchAttempts += 1;
      if (relaunchAttempts > MAX_RELAUNCH_ATTEMPTS) {
        logAgentEvent({
          eventType: 'agent.error',
          errorCategory: 'chromium_relaunch_exhausted',
          attempt: relaunchAttempts,
        });
        return;
      }

      // Tear down any stale workers from a previous browser instance.
      for (const w of workers) {
        w.poller?.stop();
        try {
          w.relay.stop();
        } catch {
          /* best effort */
        }
      }
      workers = [];

      const launched = await launchChromium({
        userDataDir: config.profileDir,
        // A real user profile (the signed-in daily Chrome) is large — give
        // its first launch a generous window.
        timeoutMs: 90_000,
        totalBudgetMs: 180_000,
        retryDelayMs: 8_000,
        onDisconnected: onChromiumDisconnected,
      });
      browser = launched;

      try {
        for (let i = 0; i < workerCount; i += 1) {
          const worker = await launchWorker(launched, i);
          workers.push(worker);
          logAgentEvent({
            eventType: 'agent.relay_connected',
            worker: i,
            agentId: worker.relay.agentId() ?? undefined,
          });
        }
        relaunchAttempts = 0;
        hooks.onPoolReady?.(workers.length);
        logAgentEvent({ eventType: 'agent.boot', version: agentVersion, workers: workers.length });
      } catch (e) {
        logAgentEvent({
          eventType: 'agent.error',
          errorCategory: 'worker_launch_failed',
          error: String(e),
        });
        // Partial pool: keep whatever workers registered. If none did,
        // surface the failure by rethrowing to the relaunch loop.
        if (workers.length === 0) throw e;
        relaunchAttempts = 0;
        hooks.onPoolReady?.(workers.length);
      }
    })();
    try {
      await launching;
    } finally {
      launching = null;
    }
  }

  /**
   * Fired by puppeteer's `disconnected` event (R11.4). Trips every
   * worker's FSM to `restarting` and schedules a full pool relaunch.
   */
  function onChromiumDisconnected(): void {
    logAgentEvent({
      eventType: 'agent.error',
      errorCategory: 'chromium_disconnected',
    });
    for (const w of workers) {
      safeTransition(w.fsm, 'restarting', 'chromium_crash');
      w.relay.emitStatus('restarting', 'chromium disconnected');
      w.poller?.stop();
      w.poller = null;
    }
    if (stopped) return;
    void launch().catch((e: unknown) => {
      logAgentEvent({
        eventType: 'agent.error',
        errorCategory: 'chromium_relaunch_failed',
        error: String(e),
      });
    });
  }

  // ─── Shutdown ───────────────────────────────────────────────────────────

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    for (const w of workers) {
      w.poller?.stop();
      try {
        w.relay.stop();
      } catch {
        /* best effort */
      }
    }
    workers = [];
    const captured = browser;
    browser = null;
    if (captured !== null) {
      try {
        await Promise.race([
          captured.close(),
          new Promise<void>((resolve) => setTimeout(resolve, 3_000).unref()),
        ]);
      } catch {
        forceKillChromium(captured);
      }
    }
  }

  return {
    launch,
    stop,
    workerCount: (): number => workers.length,
    agentIds: (): (string | null)[] => workers.map((w) => w.relay.agentId()),
  };
}
