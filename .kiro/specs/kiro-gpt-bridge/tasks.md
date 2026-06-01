# Implementation Plan: kiro-gpt-bridge

## Overview

This plan converts the design into incremental coding tasks for a TypeScript npm-workspaces monorepo with four packages — `shared/`, `relay-server/`, `browser-agent/`, `kiro-extension/` — plus a root `docker-compose.yml`.

**Critical-path waves: 11.** Peak parallelism per wave: 21 tasks. Tasks were sequenced by their *true* dependencies (the symbols they import) rather than package boundaries, so independent work in different packages runs in parallel. Tests run alongside the code they validate (same wave when the test only needs the production module already built).

Property numbering matches the design's master Property list P1–P19. Every PBT file uses the strict tag comment `// Feature: kiro-gpt-bridge, Property <N>: <body>` so test ↔ design traceability is mechanical. PBTs run with `vitest --run` and `fc.assert(prop, { numRuns: 100 })` (or 200/500 for stateful or flake-prone properties). Long-running PBTs (P5 at 25 MB, P10 atomic write) are tagged `slow` and excluded from default CI.

---

## Standard Operating Procedure (Execution SOP)

This SOP applies to every leaf task. The subagent ("spec-task-execution") MUST follow it; deviations require explicit user approval.

### S1. Context-load gate (before writing any code)
1. Read `requirements.md` for the cited requirement IDs (the `_Implements:` and `_Validates:` lines).
2. Read `design.md` for the relevant section (Components and Interfaces, Data Models, Correctness Properties, or Error Handling).
3. Read every existing file the task imports from (e.g., `shared/src/schema.ts`) so types match exactly. Do NOT guess type signatures.
4. If anything in steps 1–3 is missing or contradictory, STOP and surface the conflict before writing code.

### S2. Code-write gate
1. Match the existing project's style (strict TypeScript, explicit return types on exported functions, no `any` unless the design specifies it).
2. Use exact field names from the wire schema. Renames are forbidden unless the design is updated first.
3. No new dependencies beyond those listed in the task. If a new dependency is unavoidable, surface it; do NOT silently add it.
4. Every exported function gets a TSDoc comment that names the requirement it implements (e.g., `/** Implements R5.2 (least-busy selection). */`).
5. No `console.log` in production paths. Use the structured logger.
6. No `process.exit(0)` — only `process.exit(<non-zero>)` and only where the design specifies.

### S3. Test-write gate (for each test or PBT task)
1. Tag every PBT with the exact comment: `// Feature: kiro-gpt-bridge, Property <N>: <body>`.
2. Use `fc.assert(prop, { numRuns: <N> })` with the `numRuns` value specified in the task. Do NOT lower it.
3. Stateful PBTs use `fc.commands`. Each command class is a separate small class — no mega-switch.
4. Mocks live in `<package>/test/__mocks__/` and are reset between tests via `beforeEach`.
5. Tests must run in <30 s each at default `numRuns`; if longer, mark `slow` and gate under `vitest.config.slow.ts`.

### S4. Verification gate (before marking the task done)
1. `npm run build` from the package root passes with zero TypeScript errors.
2. `npx vitest --run <file>` passes for the new/changed test files.
3. `getDiagnostics` reports zero issues on every file the task touched.
4. No new `any` types, no new ESLint disables, no `@ts-ignore`/`@ts-expect-error` without an inline justification comment naming the requirement that forced it.
5. Coverage check: every requirement ID cited in `_Implements:` has at least one assertion path in the code (manual eyeball is fine; we do not require a coverage tool).

### S5. Hand-off gate (when the task is finished)
1. The subagent reports: files created/modified, requirements implemented, properties validated, tests passing.
2. If any verification step in S4 failed twice with the same root cause, STOP, diagnose, and report — do NOT keep patching incrementally.
3. Mark the task `completed` only after S4 passes.

### S6. Wave-boundary protocol (orchestrator)
1. After every wave completes, run `npm run build` and `npm test` at the workspace root.
2. If the wave-boundary build fails, STOP. Do NOT start the next wave. Report the failure.
3. Checkpoints (waves marked CHECKPOINT) are user-visible review gates — surface a one-paragraph summary and any open questions.

### Quality gates summary

| Gate | Trigger | Owner |
|---|---|---|
| S1 | Before writing any code | subagent |
| S2 | While writing code | subagent |
| S3 | While writing tests | subagent |
| S4 | Before mark-done | subagent |
| S5 | At task completion | subagent |
| S6 | At wave boundary | orchestrator |

---

## Tasks

- [x] 1. Project skeleton and tooling
  - [x] 1.1 Initialize npm workspace root
    - Create `package.json` at repo root declaring `workspaces: ["shared", "relay-server", "browser-agent", "kiro-extension"]`
    - Add `private: true`, root scripts: `build`, `test`, `test:slow`, `lint`, `format`
    - Add devDependencies: `typescript`, `vitest`, `fast-check`, `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `prettier`
    - _Implements: project structure section of design_
  - [x] 1.2 Add base TypeScript, ESLint, Prettier, and vitest configs
    - Create `tsconfig.base.json` (strict, `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`)
    - Create root `.eslintrc.cjs`, `.prettierrc`, `.editorconfig`, `.gitignore`, `.npmrc`
    - Create `vitest.config.ts` at root with `test.include: ["**/*.test.ts"]`, `test.exclude` excluding `**/*.slow.test.ts` by default, and a `slow` test config under `vitest.config.slow.ts`
    - _Implements: testing strategy in design (vitest + fast-check, slow-tag gating)_
  - [x] 1.3 Add per-package `package.json` and `tsconfig.json` for `shared`, `relay-server`, `browser-agent`, `kiro-extension`
    - Each package has `build` (`tsc -p .`) and `test` (`vitest --run`) scripts
    - Each `tsconfig.json` extends `../tsconfig.base.json` and emits to `dist/`
    - Workspace cross-deps wired (relay/agent/extension depend on `shared`)
    - _Implements: project structure section_

- [x] 2. `shared/` — wire schema, validators, errors, events
  - [x] 2.1 Implement `shared/src/errors.ts`
    - Export `ERROR_CODES` const tuple and `ErrorCode` union exactly as listed in the design (PAYLOAD_TOO_LARGE, SCHEMA_INVALID, MALFORMED_INPUT, MESSAGE_TOO_LARGE, QUEUE_FULL, QUEUE_TIMEOUT, AGENT_DISCONNECTED, CHATGPT_ERROR, CHATGPT_UNAVAILABLE, INPUT_UNAVAILABLE, CHAT_TIMEOUT, IMAGE_TIMEOUT, CONTENT_POLICY, INVALID_PROMPT, CANCEL_DELIVERY_FAILED, SHUTDOWN, AUTH_FAILED, CAPACITY_EXCEEDED)
    - _Implements: R26.5, R26.6, R1.4, R6.6, R6.7, R7.8, R20.7, R10.5–R10.8_
  - [x] 2.2 Implement `shared/src/events.ts`
    - Export `EV` const map of Socket.IO event names per design (`request.submit`, `request.cancel`, `request.status`, `stream.chunk`, `agent.status`, `server.status`, `agent.heartbeat`, `agent.dispatch`, `agent.cancel`, `agent.ack`, `agent.status_from`)
    - _Implements: shared interface contract used by all three components_
  - [x] 2.3 Implement `shared/src/schema.ts`
    - Define `RequestId`, `ClientId`, `AgentId`, `SessionId`, `RequestType`, `TerminalStatus`
    - Define `CodeContext`, `ExpandedToken`, `Attachment`, `HistoryMessage`, `Request`, `StreamChunk`, `CancelSignal`
    - Define `RequestStatus`, `AgentStatus`, `RequestStatusEvent`, `AgentStatusEvent`, `ServerStatusEvent`, `AgentHeartbeat`, `ClientHandshake`, `AgentHandshake`
    - Match field names and types exactly per design "Wire schema"
    - _Implements: R26.1, R26.3, R26.4, R7.2_
  - [x] 2.4 Implement `shared/src/validate.ts`
    - Add `zod` dependency
    - Build Zod schemas for every type in 2.3, with per-field bounds: prompt length (1–32000 chat / 1–4000 image), `protocolVersion === 1`, history length 0–200, attachment base64 ≤ 25 MB after decode, codeContext.fileContent ≤ 200000 chars, total serialized size ≤ 25 MB enforced by caller
    - Export `validateRequest(x): { ok: true; value: Request } | { ok: false; firstFailingField: string; rule: string }`
    - Export equivalent `validateStreamChunk`, `validateCancelSignal`, `validateAgentHeartbeat`, `validateClientHandshake`, `validateAgentHandshake`
    - _Implements: R26.5, R26.6, R9.1, R10.1, R10.7, R15.4_
  - [x] 2.5 Implement `shared/src/prettyPrint.ts`
    - Implement deterministic pretty printer per design: walks tree, emits keys in `FIELD_ORDER` per type tag with unknown keys sorted lexicographically and appended, 2-space indent, no trailing newline, UTF-8
    - Provide `FIELD_ORDER` for `Request`, `StreamChunk`, `CodeContext`, `Attachment`, `HistoryMessage`, `Session`, and all status/event types
    - Export `prettyPrint<T>(typeTag: keyof typeof FIELD_ORDER, value: T): string`
    - Export `parsePrettyPrinted<T>(s: string): T` that round-trips with the JSON parser
    - _Implements: R26.2, R26.3, R26.4_
  - [x] 2.6 Implement `shared/src/base64.ts`
    - Pure-Node base64 encode/decode helpers operating on `Uint8Array`/`Buffer`
    - _Implements: R10.3, R10.4, R26.4_
  - [x] 2.7 Implement `shared/src/backoff.ts`
    - Export `exponentialBackoff(attempt: number, base = 1000, cap = 30_000): number` returning `Math.min(base * 2^(attempt-1), cap)` with attempt ≥ 1
    - _Implements: R11.1, R21.1_
  - [-]* 2.8 Write unit tests for `shared/src/errors.ts` and `shared/src/events.ts`
    - Snapshot the closed enums to lock the wire contract
    - _Implements: R26.5, R26.6_
  - [ ]* 2.9 Write property test for pretty-printer round-trip and determinism
    - **Property 5: Pretty-printer round-trip and determinism**
    - File: `shared/test/prettyPrint.property.test.ts` with the tag comment `// Feature: kiro-gpt-bridge, Property 5: parse(prettyPrint(x)) deep-equals x and prettyPrint is deterministic for structurally equal x,y`
    - Use `fc.record` to generate full `Request` and `StreamChunk` trees with attachments up to 1 MB, then assert (a) `parsePrettyPrinted(prettyPrint("Request", x))` deep-equals `x` (compare attachment base64 and decoded bytes), (b) `prettyPrint(x) === prettyPrint(structuredClone(x))` as a Buffer byte comparison
    - `numRuns: 100`; add a separate `prettyPrint.slow.test.ts` with attachments up to 25 MB (`numRuns: 20`) gated under the `slow` config
    - **Validates: Requirements 26.1, 26.2, 26.3, 26.4, 27.4**
  - [-]* 2.10 Write property test for base64 image round-trip
    - **Property 15: Image base64 round-trip**
    - File: `shared/test/base64.property.test.ts` with the tag comment `// Feature: kiro-gpt-bridge, Property 15: base64Decode(base64Encode(b)) === b for all byte buffers up to 25 MB`
    - Generate `Uint8Array` of length 0..1 MB; assert byte-equal round-trip; `numRuns: 200`
    - Add `base64.slow.test.ts` with 25 MB buffers (`numRuns: 5`) gated under `slow`
    - **Validates: Requirements 10.3, 10.4, 26.4**
  - [-]* 2.11 Write property test for backoff schedule
    - **Property 8: Reconnect backoff schedule**
    - File: `shared/test/backoff.property.test.ts` with tag comment `// Feature: kiro-gpt-bridge, Property 8: backoff(n) === min(1000 * 2^(n-1), 30000) and is non-decreasing in n`
    - Generate `n ∈ [1, 30]`; assert exact equality and monotonicity; `numRuns: 100`
    - **Validates: Requirements 11.1, 21.1**
  - [-]* 2.12 Write unit tests for `validate.ts`
    - Cover prompt-length bounds, missing required fields, oversize attachments, history length, protocolVersion mismatch, malformed types
    - Assert `firstFailingField` and `rule` are populated on failure
    - _Implements: R26.5, R26.6_

- [x] 3. CHECKPOINT — `shared/` package builds and all `shared/` tests pass
  - At wave boundary: run `npm --workspace shared run build` and `npm --workspace shared run test`. Both must pass before any other package starts importing from `shared`.

- [x] 4. `relay-server/` — config, logging, routes
  - [x] 4.1 Implement `relay-server/src/config.ts`
    - Parse and validate `PORT` (1–65535, default 3001), `KIRO_SECRET` and `AGENT_SECRET` (16–256 chars each), `RELAY_TLS_ENABLED` ∈ {"true","false"}, `RELAY_TLS_CERT`/`RELAY_TLS_KEY` (readable PEM if TLS enabled), `QUEUE_MAX_DEPTH` (100–100000, default 1000)
    - On any invalid env, log structured error identifying the variable and exit non-zero
    - _Implements: R1.1, R1.2, R2.4, R2.5, R6.5_
  - [x] 4.2 Implement `relay-server/src/log/logger.ts`
    - Use `pino` with JSON output, ISO 8601 UTC timestamps with millisecond precision
    - Provide helpers `logRequestEvent({ requestId, clientId, agentId?, eventType, durationMs? })` enforcing required fields per R24.2 and R24.3 (durationMs required for completed/cancelled/failed)
    - Wrap every log call in try/catch; on failure increment in-memory `logFailures` counter exposed via metrics; never throw
    - _Implements: R24.1, R24.2, R24.3, R24.4_
  - [x] 4.3 Implement `relay-server/src/routes/health.ts`
    - Express handler returning `{ status, uptimeSeconds, registeredAgents, registeredClients, queueDepth }`
    - `status` is `"ok"` when `registeredAgents > 0 && !allAgentsLoginRequired`, otherwise `"degraded"`
    - _Implements: R1.7, R23.4_
  - [x] 4.4 Implement `relay-server/src/routes/metrics.ts`
    - `prom-client` registry with: counter `requests_total{type,terminal}`, counter `requests_failed_total{errorCode}`, gauge `queue_depth`, gauge `agents_connected`, histogram `request_duration_seconds` (default Prom buckets), counter `log_failures_total`
    - GET /metrics responds within 1 s in Prometheus text format
    - _Implements: R24.5, R24.4_
  - [ ]* 4.5 Write unit tests for `config.ts`
    - One test per invalid case (PORT out of range, missing secrets, short/long secrets, TLS enabled without cert, invalid QUEUE_MAX_DEPTH); assert process exits non-zero and emits structured error
    - _Implements: R1.2, R2.4, R2.5, R6.5_
  - [ ]* 4.6 Write integration test for `/health` and `/metrics`
    - Boot Express + the route handlers with a stubbed dispatcher; assert JSON shape for /health and Prometheus text content for /metrics; assert /metrics responds in <1000 ms
    - _Implements: R1.7, R24.5_

- [x] 5. `relay-server/` — auth and rate limiting
  - [x] 5.1 Implement `relay-server/src/auth/secret.ts`
    - Constant-time comparison via `crypto.timingSafeEqual` over equal-length buffers; mismatched lengths short-circuit to `false` after a constant-time pad
    - _Implements: R2.1, R2.2, R2.3, R2.5_
  - [x] 5.2 Implement `relay-server/src/auth/rateLimiter.ts`
    - In-memory `Map<string, { failures: number[]; lockedUntil: number | null }>` keyed by source IP
    - On each attempt: prune `failures` older than 60s; if 5+ remain, set `lockedUntil = now + 300_000`; if locked, reject without checking secret
    - Periodic prune task removes entries with empty failures and no active lockout
    - Export `tryConnect(ip, success)` returning `{ allowed: boolean; lockedUntil?: number }`
    - _Implements: R2.6_
  - [x] 5.3 Wire handshake auth in the Socket.IO middleware
    - Within 5 s of socket connect, require auth payload (`kiroSecret` for client, `agentSecret` for agent); validate via `secret.ts`; missing/non-matching/late → reject with structured log carrying client IP and ISO 8601 UTC timestamp; cap of 50 concurrent registered clients (R4.6, R4.7)
    - _Implements: R2.1, R2.2, R2.3, R4.4, R4.6, R4.7_
  - [ ]* 5.4 Write unit tests for `secret.ts` (constant-time, length-mismatch behavior)
    - _Implements: R2.1, R2.5_
  - [ ]* 5.5 Write property test for IP rate limiter
    - **Property 9: IP brute-force lockout**
    - File: `relay-server/test/rateLimiter.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 9: an IP is locked at time t iff it had >=5 failures within a trailing 60s window at some t* <= t and t < t* + 300000`
    - Use `fc.commands` over `Attempt(success: boolean, t: number)` with monotone-increasing times; reference impl is a naive O(n) limiter; assert production output equals reference at every step; `numRuns: 200`
    - **Validates: Requirements 2.6**

- [x] 6. `relay-server/` — agent pool, pending queue, request table
  - [x] 6.1 Implement `relay-server/src/dispatch/agentPool.ts`
    - Sets `idle: Map<AgentId,AgentState>`, `busy: Map<AgentId,{requestId,dispatchedAt}>`, `loginRequired: Set<AgentId>`, `disconnected: Set<AgentId>`
    - `AgentState` carries `agentId`, `socketId`, `registeredAt`, `lastHeartbeatAt`, `recentDispatches: number[]`, `lastCompletionAt: number | null`
    - Methods: `register`, `markBusy`, `markIdle`, `markLoginRequired`, `markReady`, `disconnect`, `onHeartbeat(agentId)`
    - `setInterval(1000)` heartbeat watcher moving any agent with `lastHeartbeatAt < now - 45_000` to disconnected; emits a `disconnected` event for the dispatcher to consume
    - On disconnect, generate a fresh `agentId` on next register (R3.5)
    - _Implements: R3.1, R3.2, R3.3, R3.5, R3.6, R23.2_
  - [x] 6.2 Implement `relay-server/src/dispatch/leastBusy.ts`
    - Pure `pickIdleAgent(idle: AgentState[]): AgentState | null`
    - Prune `recentDispatches` older than 60 s; primary sort ascending by `recentDispatches.length`; tie-break ascending by `lastCompletionAt ?? 0`
    - _Implements: R5.2_
  - [x] 6.3 Implement `relay-server/src/dispatch/pendingQueue.ts`
    - Doubly-linked list with O(1) head/tail and `Map<RequestId, Node>` for O(1) cancel-by-id
    - Methods: `append(req)`, `popHead()`, `removeById(id)`, `size()`, `head()`, `nodeOf(id)`
    - 1 Hz reaper popping any node with `enqueuedAt < now - 600_000` and emitting a `queueTimeout` event for the dispatcher
    - Enforce max depth `QUEUE_MAX_DEPTH`; `append` returns `"FULL"` when at capacity
    - _Implements: R6.1, R6.4, R6.5, R6.6, R6.7, R7.7, R27.8_
  - [x] 6.4 Implement `relay-server/src/tracking/requestTable.ts`
    - `Map<RequestId, RequestRecord>` with state machine in code: legal predecessor sets enforced by a single `transition(id, next)` method; illegal transitions throw and are logged
    - Fields: `request`, `state`, `agentId`, `clientId`, `receivedAt`, `enqueuedAt`, `dispatchedAt`, `redispatchCount` (≤3)
    - _Implements: R7.2, R7.6, R7.8, R27.1_
  - [ ]* 6.5 Write unit tests for `leastBusy.ts`
    - Cover empty pool, single agent, multiple agents with varying recentDispatches counts, ties broken by `lastCompletionAt`, null `lastCompletionAt` treated as oldest
    - _Implements: R5.2_
  - [ ]* 6.6 Write unit tests for `pendingQueue.ts`
    - Cover FIFO ordering, `removeById` from head/middle/tail, `QUEUE_FULL` at capacity, reaper firing exactly when `enqueuedAt < now - 600_000`
    - _Implements: R6.1, R6.4, R6.5, R6.6, R6.7_

- [x] 7. `relay-server/` — dispatcher core
  - [x] 7.1 Implement `relay-server/src/dispatch/dispatcher.ts`
    - Public surface per design: `registerAgent`, `removeAgent`, `markAgentLoginRequired`, `markAgentReady`, `onAgentHeartbeat`, `submit`, `cancel`, `onAgentAck`, `onAgentChunk`, `onAgentTerminal`, `agentCount`, `queueDepth`
    - `submit`: idle-first dispatch in <100 ms (R5.1); when no idle agents, append to queue and emit `"queued"` status with position in <200 ms (R6.1, R6.2)
    - `tryDispatch`: mark busy, schedule 5 s ack timeout, on transport error retry up to 3 times to a different idle agent then fall back to queue with `"queued_after_dispatch_failure"` (R5.6, R5.7)
    - On ack timeout: mark agent unhealthy, restore request to head of queue, emit `"redispatching"` (R5.8)
    - `cancel`: head-of-queue case, in-flight case (forward to assigned agent within 1 s), unknown case (ack only); enforce `CANCEL_DELIVERY_FAILED` failure if not delivered within 5 s (R20.3, R20.5, R20.6, R20.7)
    - On agent disconnect mid-flight: redispatch up to 3 times then transition to `failed` with `AGENT_DISCONNECTED` (R3.4, R7.8)
    - `onAgentIdle` drain loop: while queue non-empty and idle pool non-empty, pop head and dispatch — guarantees FIFO across simultaneous idle transitions (R6.3, R7.3)
    - `onAgentChunk`: route only to originating client (P4); on `isFinal:true` mark agent idle, complete request, run drain
    - _Implements: R5.1, R5.3, R5.4, R5.5, R5.6, R5.7, R5.8, R6.1, R6.2, R6.3, R6.4, R6.7, R6.8, R7.1, R7.2, R7.3, R7.4, R7.5, R7.6, R7.7, R7.8, R20.3, R20.5, R20.6, R20.7, R23.3, R23.5, R23.6_
  - [x] 7.2 Wire client-disconnect cancellation
    - On client disconnect, within 2 s emit `Cancel_Signal` to every assigned agent for in-flight requests originated by that client AND remove that client's queued requests from the pending queue without dispatching them (R4.5, R6.8)
    - _Implements: R4.5, R6.8_
  - [x] 7.3 Wire SHUTDOWN drain
    - SIGTERM/SIGINT handler: stop accepting new connections, allow in-flight up to 30 s, then send a `stream.chunk { isFinal:true, status:"failed", errorCode:"SHUTDOWN" }` to remaining clients and exit
    - _Implements: R1.5, R1.6_
  - [ ]* 7.4 Write property test for no-loss
    - **Property 1: No-loss (every acknowledged request reaches a terminal state)**
    - File: `relay-server/test/dispatcher.noLoss.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 1: every acknowledged request eventually reaches exactly one terminal state of completed, cancelled, failed, or queue_timeout`
    - Use `fc.commands` over `SubmitRequest`, `RegisterAgent`, `DisconnectAgent`, `AgentAck`, `AgentChunk(isFinal)`, `AgentChunkError`, `Cancel`, `ClientDisconnect`, `Tick(ms)`, `LoginRequired`, `LoginRecovered`
    - At end of trace, assert every submitted requestId is in a terminal state (or one `Tick` reachable to terminal under the model); also assert at every step that transitions follow legal predecessors
    - `numRuns: 500` (flake-prone)
    - **Validates: Requirements 3.4, 4.5, 5.6, 5.7, 6.8, 7.2, 7.6, 7.8, 20.7, 23.3, 27.1**
  - [ ]* 7.5 Write property test for FIFO under all-busy
    - **Property 2: FIFO under all-busy**
    - File: `relay-server/test/dispatcher.fifo.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 2: when all agents are busy at submit time, requests are dispatched in arrival order as agents become idle`
    - Pre-condition: register N agents and pin them busy with filler requests; then `fc.commands` over `SubmitRequest`, `AgentBecomesIdle`, `AgentBatchIdle(k)`, `Cancel`, `AckTimeout`
    - Record dispatch order; assert it is a sub-sequence of arrival order, and equal to it for the requests dispatched; assert that on `AgentBatchIdle(k)` the next k dispatches are exactly the first k from the queue head
    - `numRuns: 500`
    - **Validates: Requirements 5.8, 6.3, 6.4, 7.3, 23.4, 23.5, 23.6, 27.2**
  - [ ]* 7.6 Write property test for agent-pool state consistency
    - **Property 3: State consistency of the Agent pool**
    - File: `relay-server/test/agentPool.consistency.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 3: |busy| + |idle| + |loginRequired| == |registered| with pairwise-disjoint sets and disconnected ∩ registered == ∅`
    - `fc.commands` over `RegisterAgent`, `DisconnectAgent`, `Dispatch`, `AgentChunkFinal`, `LoginRequired`, `LoginRecovered`; assert invariant after every action; `numRuns: 200`
    - **Validates: Requirements 3.1, 3.5, 5.3, 7.1, 27.3**
  - [ ]* 7.7 Write property test for request and agent mutual exclusion
    - **Property 4: Request- and Agent-mutual exclusion + chunk routing**
    - File: `relay-server/test/dispatcher.mutex.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 4: at every point no request is dispatched to >1 agent, no agent has >1 request, and every stream chunk is routed only to the originating client`
    - `fc.commands` over `Dispatch(req,agent)`, `Complete(req)`, `EmitChunk(req,observedClient)`; track `Map<RequestId,AgentId|null>`, `Map<AgentId,RequestId|null>`, originator map; assert invariants and routing equality; `numRuns: 200`
    - **Validates: Requirements 7.4, 7.5, 27.6, 27.7**
  - [ ]* 7.8 Write property test for queue-timeout enforcement
    - **Property 7: Queue-timeout enforcement**
    - File: `relay-server/test/queueTimeout.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 7: every request whose time-in-queue exceeds 600000 ms transitions to queue_timeout terminal state`
    - `fc.commands` over `Submit`, `Tick(ms)`, `AgentBecomesIdle`; assert no item in queue has `now - enqueuedAt > 600_000` after each step and that overdue items appear in terminal `queue_timeout`; `numRuns: 200`
    - **Validates: Requirements 6.7, 7.7, 27.8**
  - [ ]* 7.9 Write integration test for cancel paths
    - File: `relay-server/test/integration/cancel.test.ts`
    - Boot relay; cancel queued request → final `cancelled` chunk to client within 1 s and removal from queue; cancel in-flight → forwarded to mock agent within 1 s; cancel undeliverable for 5 s → `failed` with `CANCEL_DELIVERY_FAILED`
    - _Implements: R20.3, R20.4, R20.5, R20.6, R20.7_

- [x] 8. `relay-server/` — server boot and socket handlers
  - [x] 8.1 Implement `relay-server/src/server.ts`
    - Express app mounting `/health` and `/metrics`
    - Socket.IO with `maxHttpBufferSize = 100 * 1024 * 1024`; reject larger frames with `PAYLOAD_TOO_LARGE` log entry including socket id and message size
    - HTTPS via `https.createServer({ cert, key })` when `RELAY_TLS_ENABLED === "true"`
    - On bind failure log structured error with port number and reason and exit non-zero
    - _Implements: R1.1, R1.3, R1.4, R1.8, R2.4, R26.6_
  - [x] 8.2 Implement `relay-server/src/socket/clientHandlers.ts`
    - `request.submit`: validate via `validateRequest`; on schema error send `SCHEMA_INVALID` with first failing field within 500 ms; size-check 25 MB; otherwise call `dispatcher.submit`
    - `request.cancel`: forward to dispatcher
    - On client connect after auth: assign 16–64 char client id within 1 s; track in `clientsBySocketId`
    - On client disconnect: cancel-and-remove queued requests within 2 s
    - Re-emit (R21.3): if `request.submit` arrives with a `requestId` already present in the request table, retain existing state and discard the duplicate without re-dispatching (R21.4)
    - _Implements: R1.4, R4.4, R4.5, R6.8, R21.3, R21.4, R26.5, R26.6_
  - [x] 8.3 Implement `relay-server/src/socket/agentHandlers.ts`
    - `agent.heartbeat`: validate; on malformed, discard without updating `lastHeartbeatAt` (R3.6); on valid, update timestamp
    - `agent.ack`: clear ack timer in dispatcher
    - `stream.chunk`: validate, route via dispatcher
    - `agent.status_from`: handle `"login_required"` (mark unavailable in <1 s; broadcast to clients if all agents are login_required), `"ready"` (resume dispatch from queue head in <1 s and notify clients), `"restarting"` (mark unavailable)
    - On agent disconnect, within 5 s emit failure to each affected client with `AGENT_DISCONNECTED`
    - _Implements: R3.2, R3.3, R3.4, R3.6, R23.1, R23.2, R23.4, R23.6_
  - [x] 8.4 Implement `relay-server/src/index.ts`
    - Boot sequence: load config → init logger → build dispatcher (agent pool + pending queue + request table) → mount Express + Socket.IO → register SIGTERM/SIGINT drain handler from 7.3 → bind to PORT
    - _Implements: R1.1, R1.5, R1.6, R1.8_
  - [ ]* 8.5 Write integration test for full happy-path dispatch
    - File: `relay-server/test/integration/dispatch.test.ts`
    - Boot relay; connect two mock agents and one mock client; submit a chat request; assert `request.status:"dispatched"` within 200 ms, stream chunks routed to the client, and `requests_total{type="chat",terminal="completed"}` incremented
    - _Implements: R5.1, R5.5, R24.5_
  - [ ]* 8.6 Write integration test for queue path and queue-full
    - File: `relay-server/test/integration/queue.test.ts`
    - Pin all agents busy; submit until queue is full; assert `"queued"` status with position, ordering, and `QUEUE_FULL` rejection at capacity within 200 ms
    - _Implements: R6.1, R6.2, R6.3, R6.4, R6.6_
  - [ ]* 8.7 Write property test for extension reconnect idempotence (server side)
    - **Property 12: Extension reconnection idempotence**
    - File: `relay-server/test/reconnect.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 12: re-emitting an already-known requestId leaves the relay request table unchanged`
    - `fc.commands` over `Submit`, `Disconnect`, `Reconnect`, `DuplicateSubmit(existingReqId)`, `AgentChunkFinal`; assert that for any `DuplicateSubmit` the server's request record is byte-equal before and after; `numRuns: 200`
    - **Validates: Requirements 21.3, 21.4**

- [x] 9. CHECKPOINT — `relay-server/` builds and all relay tests pass
  - At wave boundary: `npm --workspace relay-server run build` and `npm --workspace relay-server run test` must pass. `/health` and `/metrics` integration tests must be green before the agent and extension start hitting the relay.

- [x] 10. `browser-agent/` — config, logging, relay client
  - [x] 10.1 Implement `browser-agent/src/config.ts`
    - Read and validate `AGENT_PROFILE_DIR` (must exist as absolute writable path), `RELAY_URL`, `AGENT_SECRET` (16–256 chars)
    - On invalid env, log structured error and exit non-zero
    - _Implements: R8.3, R8.4, R11.2_
  - [x] 10.2 Implement `browser-agent/src/log/logger.ts`
    - Structured JSON logger emitting `{ timestamp, requestId?, eventType, chunkIndex?, errorCategory? }`
    - _Implements: R24.6_
  - [x] 10.3 Implement `browser-agent/src/socket/relayClient.ts`
    - `socket.io-client` with custom backoff schedule from `shared/backoff.ts` starting at 1 s, capped at 30 s; reconnect indefinitely until process stops
    - On connect, send handshake `{ agentSecret, agentVersion, capabilities:{chat:true,image:true} }`
    - On `connect_error` reason `auth`: emit status `auth_failed`, close socket, resume backoff (R11.6)
    - Public API: `emitStatus`, `emitChunk`, `emitFailure`, `on("dispatch")`, `on("cancel")`
    - While disconnected, reject any incoming dispatch (R11.3)
    - Heartbeat emitter: every 15 s ± 2 s while connected and registered (R3.2)
    - _Implements: R3.2, R11.1, R11.2, R11.3, R11.6, R21.5_
  - [ ]* 10.4 Write unit tests for relay client backoff and auth-fail loop
    - Cover backoff sequence; auth failure resumes backoff; disconnected state rejects dispatches with an error response
    - _Implements: R11.1, R11.3, R11.6_

- [x] 11. `browser-agent/` — Chromium lifecycle and selectors
  - [x] 11.1 Implement `browser-agent/src/browser/selectors.ts`
    - Centralize CSS / role selectors with documented fallbacks for: `INPUT` (chat composer), `SEND` button, `STOP` button, assistant message container, `data-message-finished` marker, login landing controls, image `<img>` tags within assistant messages
    - _Implements: R9.1, R9.5, R20.4_
  - [x] 11.2 Implement `browser-agent/src/browser/chromium.ts`
    - Use `puppeteer-extra` with `puppeteer-extra-plugin-stealth`
    - `puppeteer.launch({ headless: false, userDataDir: AGENT_PROFILE_DIR, args:["--no-sandbox","--disable-blink-features=AutomationControlled"], defaultViewport: null })`
    - 3 attempts × 5 s delay within a 30 s overall budget; on exhaustion, exit non-zero
    - Wire `browser.on("disconnected")` to a callback that the state machine uses to enter `restarting`
    - _Implements: R8.1, R8.2, R8.3, R8.5, R8.10, R11.4, R11.7_
  - [x] 11.3 Implement `browser-agent/src/browser/authDetector.ts`
    - `detect(page)`: returns `"login_required"` if `page.url()` matches `/auth/login` or DOM contains the "Log in" landing button; `"ready"` if the chat composer selector is present; otherwise `"unknown"`
    - Background poller: every 10 s while paused; one-shot probe before each request
    - _Implements: R8.6, R8.7, R8.8, R8.9, R23.1_
  - [x] 11.4 Implement `browser-agent/src/state/machine.ts`
    - Typed FSM with states `booting`, `ready`, `busy`, `login_required`, `restarting`, `disconnected` and the exact transitions in the design state diagram
    - Reject illegal transitions (throw + log)
    - On `restarting`: emit `agent.status_from:"restarting"` and request relaunch from chromium.ts within 30 s; ≤3 additional retries (R11.4, R11.7)
    - _Implements: R8.6, R8.7, R8.9, R11.4, R11.5, R11.7_

- [x] 12. `browser-agent/` — chat driver and stream extractor
  - [x] 12.1 Implement `browser-agent/src/browser/chatDriver.ts`
    - On dispatch with `type === "chat"` and prompt length 1–32000: navigate (idempotent), `waitForSelector(SEL.INPUT, { timeout: 5000 })`, on timeout emit failure `INPUT_UNAVAILABLE` and release request
    - Clear input, then type each character with delay drawn uniformly from `[20, 80]` ms
    - Click `SEL.SEND` within 500 ms of finishing typing
    - _Implements: R9.1, R9.2, R9.3, R9.7_
  - [x] 12.2 Implement `browser-agent/src/browser/streamExtractor.ts`
    - Use `page.evaluateOnNewDocument` to install a `MutationObserver` on the assistant message container that posts current full innerText via a `window._kiroChunkBus(text, isFinal)` shim
    - Node side debounces into chunks emitted at most every 250 ms, computes diff-suffix as the new chunk text, tracks `chunkIndex` starting at 0
    - When DOM signals completion (`stop` button transitions to `regenerate` or `data-message-finished` attribute appears), emit `{ isFinal:true, text:fullAssembled }` within 500 ms
    - 120 s deadline timer fires `CHAT_TIMEOUT` if no chunk has been observed since submission
    - On visible chat error in DOM, emit failure `CHATGPT_ERROR` with the visible error text
    - _Implements: R9.4, R9.5, R9.6, R9.8, R16.1_
  - [ ]* 12.3 Write property test for stream consistency
    - **Property 6: Stream consistency**
    - File: `browser-agent/test/streamExtractor.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 6: the final chunk text equals the concatenation of prior chunk texts; chunks emit at most every 250 ms; 120 s with no chunks yields a final CHAT_TIMEOUT chunk`
    - Mock the page mutation bus; generate a sequence of `(chunkText, gapMs)` plus `endsWithFinal: boolean`; reference model accumulates `accumulated += chunkText`; assert (a) final isFinal text == accumulated, (b) any two consecutive non-final chunks are at most 250 ms apart, (c) no observed chunks for 120 s yields a final `CHAT_TIMEOUT` chunk and request transitions to `failed`
    - `numRuns: 200`
    - **Validates: Requirements 9.4, 9.5, 9.8, 16.1, 27.5**
  - [ ]* 12.4 Write property test for keystroke jitter range
    - **Property 16: Keystroke jitter range**
    - File: `browser-agent/test/chatDriver.jitter.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 16: every inter-keystroke delay lies in [20, 80] ms`
    - Stub `sleep` and capture delays; generate prompts of length 1..32000; assert every recorded delay is in `[20, 80]`; `numRuns: 100`
    - Add a one-shot Kolmogorov-Smirnov aggregate test (10000 samples, α=0.01) confirming uniform-distribution acceptance band
    - **Validates: Requirements 9.2**

- [x] 13. `browser-agent/` — image driver, stop action, boot
  - [x] 13.1 Implement `browser-agent/src/browser/imageDriver.ts`
    - On dispatch with `type === "image"`: validate prompt length 1–4000 and not all-whitespace, otherwise emit `INVALID_PROMPT` immediately without sending anything
    - Submit prompt with a DALL-E directive prefix; navigate first if not on the chat page; on navigation/load failure emit `CHATGPT_UNAVAILABLE`
    - Poll the assistant message container for `<img>` elements; once `<img src="https://...">` appears, use `page.evaluate` to `fetch(src)` and read as `arrayBuffer`, returning `{ mimeType, base64 }`
    - Emit final response `{ isFinal:true, mediaType, base64 }`
    - 180 s deadline → `IMAGE_TIMEOUT`; refusal text in DOM → `CONTENT_POLICY` with the refusal message
    - _Implements: R10.1, R10.2, R10.3, R10.4, R10.5, R10.6, R10.7, R10.8_
  - [x] 13.2 Implement `browser-agent/src/browser/stopAction.ts`
    - On `cancel` event: click visible "Stop generating" button if present, else send `Escape` via keyboard; complete within 2 s; emit a final response with `status:"cancelled"` and any accumulated partial text
    - _Implements: R20.4_
  - [x] 13.3 Implement `browser-agent/src/index.ts`
    - Boot sequence: load config → init logger → instantiate state machine → launch Chromium → connect relay client → wire dispatch/cancel handlers to `chatDriver`/`imageDriver`/`stopAction` → start `authDetector` poll
    - _Implements: R8.1, R8.10, R11.1, R11.4_
  - [ ]* 13.4 Write unit tests for `imageDriver.ts` validation branches
    - Empty / whitespace / >4000 → `INVALID_PROMPT` without DOM interaction; navigation failure → `CHATGPT_UNAVAILABLE`; refusal text → `CONTENT_POLICY`; deadline → `IMAGE_TIMEOUT`
    - _Implements: R10.5, R10.6, R10.7, R10.8_
  - [ ]* 13.5 Write unit test for `stopAction.ts`
    - Stop button present: clicked within 2 s; absent: `Escape` keypress within 2 s; final response carries `status:"cancelled"` and partial text
    - _Implements: R20.4_

- [x] 14. CHECKPOINT — `browser-agent/` builds and all browser-agent unit/property tests pass
  - At wave boundary: `npm --workspace browser-agent run build` and `npm --workspace browser-agent run test` must pass. The agent must boot end-to-end against a stubbed relay before the extension layer starts integrating.

- [x] 15. `kiro-extension/` — relay client and inflight tracking
  - [x] 15.1 Implement `kiro-extension/src/relay/relayClient.ts`
    - `socket.io-client` with backoff from `shared/backoff.ts` starting at 1 s, capped at 30 s; continue retrying until user explicitly cancels reconnection
    - On connect, send `{ kiroSecret, clientVersion }` handshake; on `connect_error` close socket and resume backoff
    - On reconnect, re-emit every non-terminal record from `inflight` regardless of any prior dispatched/queued ack
    - _Implements: R4.1, R4.3, R21.1, R21.3, R21.5_
  - [x] 15.2 Implement `kiro-extension/src/relay/inflight.ts`
    - `Map<RequestId, RequestRecord>` with fields `request`, `state`, `receivedChunks`, `lastChunkAt`
    - 30 s `lastChunkAt` watchdog flips the record into `"stream-interrupted"` and surfaces it to the panel
    - _Implements: R16.6, R21.3_
  - [ ]* 15.3 Write unit tests for `relayClient` reconnect path
    - Cover backoff schedule, re-registration on success, re-emit of inflight records, cancel-on-user behavior
    - _Implements: R21.1, R21.3, R21.5_

- [x] 16. `kiro-extension/` — sessions store
  - [x] 16.1 Implement `kiro-extension/src/sessions/session.ts`
    - `Session` interface per design (sessionId, createdAt, updatedAt, messages[])
    - Helpers `appendMessage`, `truncateHistory(N)`
    - _Implements: R15.1, R15.3, R15.4_
  - [x] 16.2 Implement `kiro-extension/src/sessions/store.ts`
    - One JSON file per session at `<globalStorage>/sessions/<sessionId>.json`
    - `writeAtomic`: write `<file>.tmp-<random>`, fsync, rename; up to 3 attempts with backoff 200ms × n
    - On hard failure, retain in memory and surface a non-blocking notification; retry on next message addition
    - Read at activation time and reconstruct in-memory cache
    - Use `shared/prettyPrint` so on-disk format is deterministic
    - Persist within 2 s of any message addition
    - _Implements: R15.1, R15.2, R15.5, R15.6, R15.7, R15.8, R19.6_
  - [ ]* 16.3 Write property test for atomic write
    - **Property 10: Atomic write — no partial files; eventual persistence**
    - File: `kiro-extension/test/store.atomic.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 10: target file is either absent or a previous successful write byte-equal; eventual persistence after retries`
    - Inject I/O failures at `BEFORE_TMP_WRITE`, `AFTER_TMP_WRITE_BEFORE_FSYNC`, `AFTER_FSYNC_BEFORE_RENAME`, `AFTER_RENAME` via fakeable fs
    - Assert at every step the target file is absent or content-equal to a prior successful write; after any successful write, on-disk == in-memory; in-memory retains every message added during the failure window
    - `numRuns: 200`
    - **Validates: Requirements 15.8, 19.6**
  - [ ]* 16.4 Write property test for session-history window
    - **Property 14: Session-history window**
    - File: `kiro-extension/test/sessionHistory.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 14: outgoing history equals the last min(k, N) messages of the session in chronological order`
    - Generate `k ∈ [0, 500]`, `N ∈ [1, 200]`, messages list of length k; assert outgoing `history.length === min(k, N)` and equals the last `min(k, N)` messages; `numRuns: 200`
    - **Validates: Requirements 15.3, 15.4**

- [x] 17. `kiro-extension/` — code-context resolver and truncator
  - [x] 17.1 Implement `kiro-extension/src/codeContext/resolver.ts`
    - Parse `#File:<path>` and `#Folder:<path>` tokens; resolve absolute paths against workspace root
    - Reject tokens outside workspace, missing files/folders, files >200 KB, folders >1000 files; collect errors and the original token
    - Replace `#File` with fenced UTF-8 file content; replace `#Folder` with deterministic recursive listing (cap 1000 entries)
    - If `errors.length > 0`, return a `ResolveResult` so the caller does NOT send the request and the panel surfaces each offending token with its reason
    - _Implements: R14.1, R14.2, R14.3_
  - [x] 17.2 Implement `kiro-extension/src/codeContext/truncator.ts`
    - If `byteLen(codeContext) > 200 * 1024`, truncate to exactly 200 KB and append notice `"\n\n[Code context truncated from <originalKB> KB to 200 KB]"`; otherwise no notice
    - Set `codeContext.truncated = { originalSizeBytes, truncatedToBytes: 200*1024 }` for traceability
    - _Implements: R14.4_
  - [ ]* 17.3 Write property test for code-context resolution and truncation
    - **Property 11: Code-context resolution and truncation**
    - File: `kiro-extension/test/resolver.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 11: resolve replaces tokens deterministically inside the workspace; outside-workspace, missing, oversize, or folder-too-many trigger errors; >200KB output is truncated with a notice`
    - Build a virtual workspace `Map<RelativePath, FileContent | "DIR">`; generate prompts with 0..6 `#File` and 0..3 `#Folder` tokens; reference deterministic walker; assert resolver matches reference and request is not sent on errors; assert truncator behavior at the 200 KB boundary
    - `numRuns: 200`
    - **Validates: Requirements 14.1, 14.2, 14.3, 14.4**

- [x] 18. `kiro-extension/` — webview panel and message bridge
  - [x] 18.1 Implement `kiro-extension/src/webview/messageBridge.ts`
    - Define `WebviewToHost` and `HostToWebview` exactly per design protocol
    - Type-safe `postMessage` and `onDidReceiveMessage` wrappers
    - _Implements: R12.1, R20.2_
  - [x] 18.2 Implement `kiro-extension/src/webview/ui` (HTML/CSS/JS)
    - Static webview shell: chat thread list, message list, input composer, mode toggle (Chat/Image), attachments chip area, send button, stop button per in-flight message, save action buttons per final message, Copy/Insert buttons per fenced code block
    - Render fenced code blocks with syntax highlighting matching language tag; unrecognized → monospaced plain text (R16.2, R16.3)
    - Streaming indicator hides Copy/Insert/Save until `isFinal`; on `isFinal:true` show all three (R16.4, R16.5)
    - _Implements: R12.1, R13.6, R16.2, R16.3, R16.4, R16.5, R17.1, R20.1_
  - [x] 18.3 Implement `kiro-extension/src/webview/panelProvider.ts`
    - `WebviewViewProvider` for the sidebar view id `kiroGptBridge.panel` with title `"ChatGPT Bridge"`
    - Persist mode toggle and last sessionId to `ctx.globalState`
    - Handle `submit` (with attachments and codeContextTokens), `cancel`, `newSession`, `deleteSession(confirmed)`, `saveMarkdown`, `saveImage`, `copyCode`, `insertCode`
    - On `cancel` from webview: send exactly one `request.cancel` and disable the Stop button for that message until cancellation completes or 30 s elapse
    - _Implements: R12.1, R13.6, R13.7, R13.8, R15.6, R15.7, R20.2, R22.1_
  - [ ]* 18.4 Write property test for `openPanel` idempotence
    - **Property 17: openPanel idempotence**
    - File: `kiro-extension/test/openPanel.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 17: invoking openPanel any number of times leaves exactly one registered panel`
    - Generate `n ∈ [1, 50]` invocations against a fake VS Code panel registry; assert registry size === 1 after every invocation past the first; `numRuns: 100`
    - **Validates: Requirements 12.3**
  - [ ]* 18.5 Write property test for fenced-code-block button count
    - **Property 19: Fenced-code-block button count**
    - File: `kiro-extension/test/codeBlockButtons.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 19: rendered DOM has exactly one Copy and one Insert at cursor button per fenced code block`
    - Generate markdown strings with `n ∈ [0, 20]` fenced code blocks (mixed language tags); render via the webview HTML helper into a JSDOM container; assert button counts equal n; `numRuns: 100`
    - **Validates: Requirements 13.6**

- [x] 19. `kiro-extension/` — status bar, save flows, commands
  - [x] 19.1 Implement `kiro-extension/src/status/statusBar.ts`
    - One `StatusBarItem`; render exactly one of `"disconnected"`, `"connected"`, `"streaming"`, `"queued: N"` (N 0–9999), or `"agents: M"` (M 0–999) per status event within 500 ms
    - 5 s staleness watchdog forces `"disconnected"` when no event has arrived
    - Panel-header label state machine: hold `"Cancelled"` for at least 3 s after a `cancelled` terminal before transitioning
    - _Implements: R12.8, R22.1, R22.2, R22.3, R22.4, R22.5, R22.6_
  - [x] 19.2 Implement `kiro-extension/src/files/saveMarkdown.ts`
    - Prompt for filename via `vscode.window.showInputBox` with default `.md` extension; validate length 1–255 and characters valid for the host filesystem (Windows reserved + `<>:"/\\|?*`; POSIX `/` and NUL); on invalid, re-prompt
    - Confirm overwrite if path exists; on user-decline abort without modifying file; on dismiss-without-choosing append `_YYYYMMDD-HHMMSS` suffix and write to that name
    - Atomic write (write to `.tmp` then rename) to UTF-8; surface errors with cause; if no workspace folder open, error and abort
    - _Implements: R19.1, R19.2, R19.3, R19.4, R19.5, R19.6_
  - [x] 19.3 Implement `kiro-extension/src/files/saveImage.ts`
    - Prompt for filename 1–255 with default extension matching MIME type (image/png, image/jpeg, image/webp, image/gif); validate per filesystem
    - Decode base64 and write image bytes atomically under workspace root; overwrite confirmation; abort if no workspace
    - If response carries an error code (IMAGE_TIMEOUT/CONTENT_POLICY/etc.), do NOT show the Save action
    - _Implements: R17.4, R17.5, R17.6, R17.7, R17.8, R17.9_
  - [x] 19.4 Implement `kiro-extension/src/commands/openPanel.ts`
    - Command `kiroGptBridge.openPanel` reveals the existing panel without duplication and focuses it within 1 s
    - _Implements: R12.2, R12.3_
  - [x] 19.5 Implement `kiro-extension/src/commands/codeAwareCommands.ts`
    - Register `kiroGptBridge.explainCode`, `kiroGptBridge.refactorCode`, `kiroGptBridge.generateTests`, `kiroGptBridge.documentCode`, `kiroGptBridge.findBugs`, `kiroGptBridge.optimizeCode`
    - Show only with active selection 1–100000 chars
    - On invocation include `selection`, `filePath`, `language` in `codeContext`; if either is unknown, display error and do not send
    - When invoked without selection, include the entire active file content up to 200000 chars
    - For `explainCode`: enforce 1–10000 selection length; out of range → error and no submit; submit and reveal panel within 1 s
    - _Implements: R12.4, R12.5, R13.1, R13.2, R13.3, R13.4, R13.5_
  - [x] 19.6 Implement `kiro-extension/src/commands/generateImage.ts`
    - Prompt user for description 1–1000 chars; on cancel or empty/whitespace abort silently; otherwise submit `image` request within 1 s
    - In Image panel mode, validate prompt 1–4000 chars; out of range → inline validation error and no submit
    - _Implements: R12.6, R12.7, R17.2, R17.3_
  - [x] 19.7 Implement `kiro-extension/src/commands/attachments.ts`
    - Drag-drop handler accepts `.jpg/.jpeg/.png/.gif/.webp/.pdf/.txt/.md/.docx`
    - Reject files >25 MB with explicit error; reject unsupported extensions with error; render a chip with filename and remove control
    - On submit, include base64 + filename per accepted attachment in the request payload
    - _Implements: R18.1, R18.2, R18.3, R18.4, R18.5_
  - [x] 19.8 Implement `kiro-extension/src/extension.ts`
    - `activate(ctx)`: load `kiroGptBridge.relayUrl` setting; on missing/empty/invalid URL show error and do not connect (R4.2); construct `RelayClient`; register all commands and the WebviewViewProvider; register status bar item; restore sessions
    - `deactivate()`: close socket, persist any pending sessions
    - _Implements: R4.1, R4.2, R12.1, R28.2, R28.6_
  - [ ]* 19.9 Write property test for status-bar label domain
    - **Property 13: Status-bar label domain**
    - File: `kiro-extension/test/statusBar.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 13: status-bar text matches the documented label set; 5s without events forces disconnected; cancelled label persists at least 3s`
    - Generate sequences of `StatusEvent` with random `agentsConnected`, `queueDepth`, terminal events, and `Tick(ms)`; assert at every render the text matches `^(disconnected|connected|streaming|queued: \d{1,4}|agents: \d{1,3})$`; after 5 s with no event text == `"disconnected"`; after a `cancelled` terminal the panel-header label remains `"Cancelled"` for ≥ 3 s before any other label
    - `numRuns: 200`
    - **Validates: Requirements 12.8, 22.1, 22.5, 22.6**
  - [ ]* 19.10 Write property test for code-aware command CodeContext fields
    - **Property 18: Code-aware command CodeContext fields**
    - File: `kiro-extension/test/codeAware.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 18: outgoing codeContext has non-empty selection, filePath, and language for any valid invocation`
    - Generate `(selectionLen ∈ [1,10000], filePath, language)` triples with non-empty values; assert outgoing `codeContext.selection`, `.filePath`, `.language` are all non-empty; `numRuns: 100`
    - **Validates: Requirements 13.3**
  - [ ]* 19.11 Write unit tests for `saveMarkdown`/`saveImage` filename validation and overwrite behavior
    - Cover invalid characters, Windows reserved names, length bounds, overwrite confirm/decline/dismiss, no-workspace error, atomic write success, atomic write failure leaves no partial file
    - _Implements: R17.4, R17.5, R17.6, R17.7, R17.8, R19.1, R19.2, R19.3, R19.4, R19.5, R19.6_
  - [ ]* 19.12 Write unit tests for attachment validation
    - Supported / unsupported extensions; >25 MB rejection; chip render and remove; payload includes base64 + filename
    - _Implements: R18.1, R18.2, R18.3, R18.4, R18.5_

- [x] 20. CHECKPOINT — `kiro-extension/` builds and all extension unit/property tests pass
  - At wave boundary: `npm --workspace kiro-extension run build` and `npm --workspace kiro-extension run test` must pass before integration tests start. The webview must render in a JSDOM container.

- [x] 21. Integration: cross-component wiring
  - [x] 21.1 Implement `relay-server/Dockerfile`
    - Multi-stage build of the relay only; non-root user; expose 3001
    - _Implements: R25.1, R25.2_
  - [x] 21.2 Author root `docker-compose.yml`
    - Service `relay` running the relay on container port 3001 published to host 3001
    - Accept env vars `KIRO_SECRET` (required), `AGENT_SECRET` (required), `RELAY_TLS_ENABLED`, `RELAY_TLS_CERT`, `RELAY_TLS_KEY`
    - HEALTHCHECK directive polling `/health` every 30 s with 5 s timeout and 3 retries
    - Document that Browser_Agent runs locally outside Docker by default (R25.4)
    - _Implements: R25.1, R25.2, R25.3, R25.4_
  - [x] 21.3 Author top-level `README.md`
    - Document run-locally instructions for relay and browser-agent, env vars, settings (`kiroGptBridge.relayUrl`, `kiroGptBridge.sessionHistoryMax`), and the explicit out-of-scope boundaries from R28
    - _Implements: R28.1, R28.2, R28.3, R28.4, R28.5, R28.6_
  - [ ]* 21.4 Write end-to-end smoke test (mock agent, real relay, real extension client)
    - File: `e2e/smoke.test.ts`
    - Start the relay process; connect a mock browser-agent (no real Chromium) and an extension-equivalent socket client; submit one chat request, observe streamed chunks, terminal `completed`; submit one image request via mock DALL-E pipe, observe `mediaType` + base64; cancel a queued request and a streaming request; assert /health and /metrics
    - _Implements: R5.1, R5.5, R6.1, R6.2, R10.4, R20.3, R20.4, R20.5, R24.5_
  - [ ]* 21.5 Write Docker Compose smoke test
    - File: `e2e/docker.test.ts`
    - Run `docker compose config` to validate the file; build and run the relay container; curl `/health` to confirm `HEALTHCHECK` directive is active and returns 200
    - _Implements: R25.1, R25.3_
  - [ ]* 21.6 Write outbound-network boundary test
    - File: `e2e/networkBoundary.test.ts`
    - Hook outbound DNS/connect; submit a chat request through the extension client → mock agent; assert the only outbound destinations during the lifecycle are the configured relay URL (from extension) and `chat.openai.com` (from agent); reject any other host
    - _Implements: R28.3, R28.4_

- [x] 22. Visual asset automation (R29 + R30) — extension layer
  - [x] 22.1 Implement `kiro-extension/src/assets/slugify.ts`
    - Pure `slugify(prompt: string, maxLen = 40): string` — lowercase, ASCII a–z 0–9 and hyphens only, collapsed hyphens, trim leading/trailing hyphens, idempotent
    - _Implements: R30.3_
  - [x] 22.2 Implement `kiro-extension/src/assets/frameworkDetector.ts`
    - Inspect workspace root in priority order from R30.1; cache result for 30 s; export `detectFramework(root): "next"|"nuxt"|"sveltekit"|"vite"|"angular"|"cra"|"unknown"`
    - _Implements: R30.1_
  - [x] 22.3 Implement `kiro-extension/src/assets/pathResolver.ts`
    - Pure `resolvePath({ framework, assetCategory, filename, workspaceRoot })` returning absolute target path per the R30.2 mapping; never returns a path outside `workspaceRoot`
    - Implement unique-suffix appender `-2..-99` for collision avoidance when `overwrite=false`
    - _Implements: R30.2, R30.4_
  - [x] 22.4 Implement `kiro-extension/src/assets/assetGenerator.ts`
    - Orchestrator: resolve framework → resolve path → submit image Request via existing `RelayClient` → await final Response → atomic write via `saveImage` helper
    - Auto-`mkdir -p` for missing intermediate folders (R30.5)
    - Returns `ImageResult` per R29.1 shape; converts thrown errors to `{ ok:false, errorCode, message }` per R29.7
    - Show non-blocking VS Code notification with "Reveal in Explorer" action (R29.8)
    - _Implements: R29.3, R29.4, R29.5, R29.6, R29.7, R29.8, R30.5_
  - [x] 22.5 Implement `kiro-extension/src/api/extensionApi.ts`
    - Exports the public extension API object returned from `activate(ctx)` containing `generateImage(options): Promise<ImageResult>` per R29.1, R29.2
    - Wire activate(): return this API object
    - _Implements: R29.1, R29.2_
  - [x] 22.6 Implement `kiro-extension/src/assets/missingAssetScanner.ts`
    - Pure scanner with regex set covering `<img src="…">`, `<Image src="…">`, `![alt](path)`; returns `Array<{ range, kind, path, altOrCaption, inferredCategory }>`; only reports paths resolved inside the workspace AND missing on disk; infers `assetCategory` from filename heuristics (`logo|hero|icon|bg|background|mockup`)
    - _Implements: R30.6_
  - [x] 22.7 Implement `kiro-extension/src/assets/missingAssetCodeLens.ts`
    - VS Code `CodeLensProvider` for `tsx, jsx, vue, svelte, html, astro`; emits a "Generate this image" code lens per scanner result; on click, calls `extensionApi.generateImage(...)` with prompt = altOrCaption + 5 lines of surrounding code, plus the inferred `assetCategory`
    - _Implements: R30.6_
  - [x] 22.8 Implement `kiro-extension/src/commands/generateMissingAssets.ts`
    - Registers `kiroGptBridge.generateMissingAssets`; runs scanner against active editor; opens single confirmation dialog listing every missing asset; on confirm calls `assetGenerator.generate` for each in series
    - _Implements: R30.7_
  - [x] 22.9 Extend logger to include `origin: "panel"|"api"|"missing-asset"|"mcp"`
    - Update both relay-server `logRequestEvent` and the extension's panel logger; `panelProvider` calls pass `origin:"panel"`, `assetGenerator` passes the origin from its caller (default `"api"`)
    - _Implements: R30.8_
  - [-]* 22.10 Property test for `slugify`
    - **Property 21: Slugify safety**
    - File: `kiro-extension/test/slugify.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 21: slugify output is ≤40 chars, charset [a-z0-9-], no leading/trailing/double hyphens, idempotent`
    - Generate arbitrary unicode strings; assert charset, length, idempotence, no `--`, no leading/trailing `-`; `numRuns: 200`
    - **Validates: R30.3**
  - [-]* 22.11 Property test for `pathResolver`
    - **Property 20: Path resolver determinism**
    - File: `kiro-extension/test/pathResolver.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 20: pathResolver returns deterministic, in-workspace paths matching the framework→category mapping`
    - Generate `(framework, assetCategory, filename, workspaceRoot)` tuples; assert path is always inside workspaceRoot, deterministic, and matches the design table; `numRuns: 200`
    - **Validates: R30.1, R30.2**
  - [-]* 22.12 Property test for unique-suffix terminator
    - **Property 22: Unique-suffix terminator**
    - File: `kiro-extension/test/uniqueSuffix.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 22: with overwrite=false, resolver either returns a unique suffixed path -2..-99 or errorCode TARGET_EXISTS`
    - Pre-populate a virtual fs with N existing files at the target name; call resolver with overwrite=false; assert never overwrites, never returns same path twice, terminates at TARGET_EXISTS by N=99; `numRuns: 200`
    - **Validates: R30.4**
  - [-]* 22.13 Property test for missing-asset scanner
    - **Property 23: Missing-asset detector**
    - File: `kiro-extension/test/missingAssetScanner.property.test.ts` with tag `// Feature: kiro-gpt-bridge, Property 23: scanner reports exactly the references whose resolved path is inside the workspace and missing on disk`
    - Generate source strings with random `<img>`, `<Image>`, and `![](…)` references mixed against a virtual workspace; assert exact set equality with reference walker; `numRuns: 200`
    - **Validates: R30.6**
  - [-]* 22.14 Unit test for `frameworkDetector`
    - One test per framework signal file; one for `unknown`; one verifying 30 s cache
    - _Implements: R30.1_
  - [-]* 22.15 Unit test for `extensionApi.generateImage` error branches
    - WORKSPACE_REQUIRED, TARGET_EXISTS, IMAGE_TIMEOUT, CONTENT_POLICY, INVALID_PROMPT, AGENT_DISCONNECTED — each resolves (not rejects) with the right errorCode
    - _Implements: R29.5, R29.6, R29.7_

- [x] 23. MCP server (R31)
  - [x] 23.1 Initialize `mcp-server/` package
    - `package.json` with deps `@modelcontextprotocol/sdk`, `socket.io-client`, workspace dep on `shared`; `tsconfig.json` extends base; `build` and `test` scripts
    - _Implements: R31.1_
  - [x] 23.2 Implement `mcp-server/src/relayClient.ts`
    - Thin Socket.IO client mirroring the extension's RelayClient (handshake `{ kiroSecret: process.env.KIRO_GPT_MCP_SECRET, clientVersion }`); reconnect using `shared/backoff.ts`
    - _Implements: R31.2_
  - [x] 23.3 Implement `mcp-server/src/workspaceResolver.ts`
    - Reads `KIRO_GPT_MCP_WORKSPACE` env at boot; per-call argument overrides; throws if neither is set when a tool tries to write
    - _Implements: R31.5, R31.7_
  - [x] 23.4 Implement `mcp-server/src/promptTemplates.ts`
    - Versioned templates for `generate_logo`, `generate_hero`, `generate_icon_set`, `generate_ui_mockup` (centralized so prompt phrasing changes don't drift across tools)
    - _Implements: R31.3, R31.4_
  - [x] 23.5 Implement the five MCP tool handlers under `mcp-server/src/tools/`
    - `generateImage.ts`, `generateLogo.ts`, `generateHero.ts`, `generateIconSet.ts`, `generateUiMockup.ts` — each builds a prompt from the template, submits an image Request via `relayClient`, awaits the final Response, decodes base64, writes to the resolved path, returns `McpImageResult`
    - `generate_icon_set` loops over `names: string[]` and returns `savedPaths: string[]`
    - On `RELAY_UNREACHABLE`, all tools return `{ ok:false, errorCode:"RELAY_UNREACHABLE" }` without writing anything
    - _Implements: R31.3, R31.4, R31.6, R31.7_
  - [x] 23.6 Implement `mcp-server/src/index.ts`
    - stdio MCP server boot; register the five tools with the SDK; connect relayClient on startup; clean shutdown on stdin close
    - _Implements: R31.1, R31.2_
  - [x] 23.7 Author the example `mcp.json` snippet in the README
    - Show how to register `kiro-gpt-bridge` in `.kiro/settings/mcp.json` with `command: "node"`, `args: ["./mcp-server/dist/index.js"]`, `env: { KIRO_GPT_MCP_SECRET, KIRO_GPT_MCP_WORKSPACE }`
    - _Implements: R31.8_
  - [ ]* 23.8 Integration test: MCP tool roundtrip
    - File: `mcp-server/test/integration/mcp.test.ts`
    - Boot relay + mock browser-agent + the MCP server; call `generate_logo` via the SDK client; assert `{ ok:true, savedPath, mimeType, prompt, requestId, assetCategory:"logo" }` and the file exists at the expected path
    - _Implements: R31.3, R31.6_
  - [ ]* 23.9 Integration test: MCP `RELAY_UNREACHABLE`
    - Boot the MCP server with no relay running; call `generate_image`; assert `{ ok:false, errorCode:"RELAY_UNREACHABLE" }` and no file written
    - _Implements: R31.7_

- [x] 24. Steering and hooks (R32)
  - [x] 24.1 Author `.kiro/steering/visual-assets.md`
    - Front-matter `inclusion: fileMatch`, `fileMatchPattern: "**/*.{tsx,jsx,vue,svelte,html,css,scss,astro}"`
    - Body documenting the five MCP tools, parameters, example call, and the auto-generation directive per R32.2 / R32.3
    - _Implements: R32.1, R32.2, R32.3_
  - [x] 24.2 Author `.kiro/hooks/generate-missing-assets.kiro.hook`
    - `fileEdited` against the frontend file patterns; `askAgent` prompt instructs running `kiroGptBridge.generateMissingAssets` and using the MCP tools to generate any missing assets
    - _Implements: R32.4_
  - [x] 24.3 Author `.kiro/hooks/generate-spec-assets.kiro.hook`
    - `userTriggered`, name "Generate visual assets for active spec"; `askAgent` prompt instructs reading the active spec's design.md, listing visual assets, generating each via the MCP tools, then updating design.md with `savedPath` references
    - _Implements: R32.5_
  - [x] 24.4 Register `kiroGptBridge.autoGenerateAssets` setting
    - In the extension's `package.json` contributes section: boolean, default true, description per R32.7
    - On change, the extension annotates `.kiro/steering/visual-assets.md` at runtime with a "DISABLED — auto-generation is off via user setting" notice when false (R32.6, R32.7)
    - _Implements: R32.6, R32.7_
  - [x] 24.5 Update `README.md` with the visual-asset workflow
    - Document the MCP server config, the steering file, both hooks, the auto-generation setting, and the recommended workflow per R32.8
    - _Implements: R32.8_
  - [ ]* 24.6 Smoke test: hook and steering files are valid
    - File-existence check + JSON.parse for hook files + frontmatter parse for steering file
    - _Implements: R32.1, R32.4, R32.5_

- [x] 25. FINAL CHECKPOINT — all packages build and all default-config tests pass
  - At wave boundary: `npm run build` and `npm run test` from the workspace root must pass across all five packages (`shared`, `relay-server`, `browser-agent`, `kiro-extension`, `mcp-server`). Run `npm run test:slow` once to validate the gated PBTs (P5 25 MB, P10 atomic write).

## Notes

- Sub-tasks marked with `*` are optional test/verification tasks. Core implementation tasks are required.
- Each PBT file uses the strict tag comment `// Feature: kiro-gpt-bridge, Property <N>: <body>` so test ↔ design traceability is mechanical.
- All PBTs run with `vitest --run` and `fc.assert(prop, { numRuns: 100 })` (or 200/500 for stateful or flake-prone properties such as P1, P2). Long-running PBTs (P5 at 25 MB attachments, P10 atomic write) are tagged `slow` and excluded from the default config.
- Property numbering matches the design's master Property list (P1–P19). Each PBT task explicitly references the property by number and the requirements it validates.
- Checkpoints (3, 9, 14, 20, 22) split the plan into incrementally verifiable phases and are user-visible review gates.
- The 23 master correctness properties are covered as follows:
  - **shared/**: P5 (2.9), P15 (2.10), P8 (2.11)
  - **relay-server/**: P9 (5.5), P1 (7.4), P2 (7.5), P3 (7.6), P4 (7.7), P7 (7.8), P12 (8.7)
  - **browser-agent/**: P6 (12.3), P16 (12.4)
  - **kiro-extension/**: P10 (16.3), P14 (16.4), P11 (17.3), P17 (18.4), P19 (18.5), P13 (19.9), P18 (19.10), P20 (22.11), P21 (22.10), P22 (22.12), P23 (22.13)

### Parallelism analysis

The graph below was tightened by analyzing each leaf's *true* dependencies (the symbols it imports), not artificial package boundaries. Independent work in different packages now runs in the same wave. Tests run alongside the production code they validate when the test only needs the module already built.

- **11 critical-path waves** (down from 14)
- **Peak wave width: 22 tasks** (up from 14) — waves 5 and 6 each fan out to 22 parallel tasks
- **Across-package parallelism**: starting at wave 4, work proceeds simultaneously in `relay-server/`, `browser-agent/`, and `kiro-extension/` — they all only need `shared/` to be done.
- **Tests stay close to code**: P5/P8/P15 (shared PBTs) run in waves 3–5; P9 (rate limiter) runs in wave 6; resolver/truncator PBT (P11) runs in wave 5 alongside the resolver itself.
- **Total leaf tasks: 128** (98 core + 30 visual-asset/MCP/steering), every one placed in exactly one wave.
- **Visual asset layer (R29–R32)**: extension API + framework detection + path resolver + slugify + missing-asset scanner + CodeLens + generateMissingAssets command, plus the `mcp-server/` package (5 tools) and the steering file + 2 hooks. New PBTs P20–P23 cover path-resolver determinism, slugify safety, unique-suffix terminator, and missing-asset detection.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1", "2.2", "2.6", "2.7"] },
    { "id": 3, "tasks": ["2.3", "2.8", "2.10", "2.11", "11.1", "21.1", "21.3"] },
    { "id": 4, "tasks": ["2.4", "2.5", "4.1", "4.2", "10.1", "10.2", "16.1", "17.1", "17.2", "18.1", "21.2"] },
    { "id": 5, "tasks": ["2.9", "2.12", "4.3", "4.4", "5.1", "5.2", "6.1", "6.2", "6.3", "6.4", "10.3", "11.2", "11.3", "13.2", "15.1", "15.2", "16.2", "17.3", "18.2", "19.1", "19.2", "19.3"] },
    { "id": 6, "tasks": ["4.5", "4.6", "5.3", "5.4", "5.5", "6.5", "6.6", "7.1", "10.4", "11.4", "12.1", "13.1", "13.5", "15.3", "16.3", "16.4", "18.3", "19.4", "19.6", "19.7", "19.11", "19.12"] },
    { "id": 7, "tasks": ["7.2", "7.3", "7.4", "7.5", "7.6", "7.7", "7.8", "12.2", "13.3", "13.4", "18.4", "18.5", "19.5", "19.10"] },
    { "id": 8, "tasks": ["8.1", "8.2", "8.3", "12.3", "12.4", "19.8", "19.9"] },
    { "id": 9, "tasks": ["8.4", "8.7", "22.1", "22.2", "22.3", "22.6", "23.1", "23.7", "24.1", "24.2", "24.3", "24.5"] },
    { "id": 10, "tasks": ["7.9", "8.5", "8.6", "21.4", "21.5", "21.6", "22.4", "22.7", "22.10", "22.11", "22.12", "22.13", "22.14", "23.2", "23.3", "23.4", "24.4", "24.6"] },
    { "id": 11, "tasks": ["22.5", "22.8", "22.9", "22.15", "23.5"] },
    { "id": 12, "tasks": ["23.6", "23.8", "23.9"] }
  ]
}
```

### Wave-by-wave intent

- **Wave 0**: workspace root only. Nothing else can begin until `package.json` exists.
- **Wave 1**: tooling configs (`tsconfig.base`, vitest, eslint) plus per-package `package.json`/`tsconfig`. These are independent.
- **Wave 2**: pure leaf modules in `shared/` with zero dependencies (errors, events, base64, backoff). Snapshot/contract tests (2.8) sit in wave 3 alongside `schema.ts`.
- **Wave 3**: `schema.ts` lands. PBTs that only need pure leaves (P15 base64, P8 backoff) ship here. `browser-agent/selectors.ts` and the `Dockerfile` + `README` start in parallel — they don't need `shared/` types.
- **Wave 4**: validators + pretty-printer (need schema), config modules in all three downstream packages (need shared types), session interface, code-context resolver/truncator, webview message bridge (defines the protocol the UI will obey). `docker-compose.yml` lands here.
- **Wave 5**: the largest wave (21 tasks). Auth secret + rate limiter, agent pool + queue + leastBusy + request table, relay client (browser-agent and extension), Chromium launcher, auth detector, stop action, sessions store, status bar, save-markdown, save-image, webview UI shell. PBTs that only need their target module: P5 (pretty-printer round-trip), P9 (rate limiter), P11 (resolver), validate.ts unit tests.
- **Wave 6**: dispatcher core lands (depends on wave-5 pool/queue/table), state machine, chat driver, image driver, panel provider. Unit tests for everything in wave 5 ship here. Atomic-write PBT (P10), session-history PBT (P14), most of the kiro-extension command surface.
- **Wave 7**: dispatcher PBTs (P1 no-loss, P2 FIFO, P3 state-consistency, P4 mutex, P7 queue-timeout) — they need `dispatcher.ts`. Stream extractor (depends on chat driver), agent boot. PBTs P17 / P19 (panel + code-block buttons), code-aware commands (P18).
- **Wave 8**: server boot pieces (`server.ts`, socket handlers) — they wire dispatcher into the transport. Stream PBTs P6 / P16. Extension activate/deactivate. Status-bar PBT (P13).
- **Wave 9**: `index.ts` for the relay (depends on socket handlers + server), reconnect-idempotence PBT (P12). In parallel: visual-asset pure modules (slugify, frameworkDetector, pathResolver, missing-asset scanner — all dep-free), `mcp-server/` package init, steering file, both hooks, README updates.
- **Wave 10**: integration tests (cancel, dispatch, queue), the three e2e/Docker/network-boundary tests, `assetGenerator` (depends on relay client which is wave 5), CodeLens, the four visual-asset PBTs (P20–P23), framework-detector unit test, MCP relayClient + workspaceResolver + promptTemplates, `kiroGptBridge.autoGenerateAssets` setting wiring, hook smoke tests.
- **Wave 11**: extension API surface (depends on assetGenerator), generateMissingAssets command (depends on scanner + assetGenerator), logger origin field, extensionApi error-branch tests, MCP tool handlers (depend on relayClient + workspaceResolver + promptTemplates).
- **Wave 12**: MCP server boot (depends on tool handlers), MCP integration tests.

