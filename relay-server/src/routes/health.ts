import type { Request, Response } from 'express';

/**
 * JSON body returned by `GET /health`.
 *
 * Implements R1.7 (exact field set) and R23.4 (status reflects whether
 * every registered agent is in `login_required`).
 */
export interface HealthSnapshot {
  /**
   * Overall relay health.
   *
   * - `'ok'`: at least one agent is registered AND not all of them are
   *   in `login_required` state.
   * - `'degraded'`: zero agents registered, or every registered agent
   *   is in `login_required` state.
   *
   * Implements R23.4.
   */
  status: 'ok' | 'degraded';
  /** Seconds since the relay process started, integer or fractional. */
  uptimeSeconds: number;
  /** Count of agents currently registered with the dispatcher. */
  registeredAgents: number;
  /** Count of authenticated KIRO clients currently connected. */
  registeredClients: number;
  /** Current depth of the pending request queue. */
  queueDepth: number;
}

/**
 * Inputs the `/health` handler reads at request time. Provided as a
 * provider object so the route doesn't import the dispatcher directly —
 * decoupled for testability and to avoid a cycle with the dispatcher
 * module that will be wired in task 8.4.
 *
 * Implements R1.7 (JSON shape), R23.4 (status reflects login_required).
 */
export interface HealthProvider {
  /** Seconds since the relay process started. */
  uptimeSeconds(): number;
  /** Number of agents currently registered with the dispatcher. */
  registeredAgents(): number;
  /** Number of authenticated KIRO clients currently connected. */
  registeredClients(): number;
  /** Current depth of the pending request queue. */
  queueDepth(): number;
  /** True iff every registered agent is in `login_required`. */
  allAgentsLoginRequired(): boolean;
}

/**
 * Pure helper that derives a {@link HealthSnapshot} from a
 * {@link HealthProvider}. Exported separately from
 * {@link createHealthHandler} so unit tests can exercise the status
 * logic without spinning up Express.
 *
 * Status rule (per R23.4):
 * - `registeredAgents() === 0` → `'degraded'`
 * - `allAgentsLoginRequired()` → `'degraded'`
 * - otherwise → `'ok'`
 *
 * Implements R1.7, R23.4.
 */
export function buildHealthSnapshot(provider: HealthProvider): HealthSnapshot {
  const registeredAgents = provider.registeredAgents();
  const status: 'ok' | 'degraded' =
    registeredAgents === 0 || provider.allAgentsLoginRequired() ? 'degraded' : 'ok';

  return {
    status,
    uptimeSeconds: provider.uptimeSeconds(),
    registeredAgents,
    registeredClients: provider.registeredClients(),
    queueDepth: provider.queueDepth(),
  };
}

/**
 * Build an Express handler for `GET /health`. Returns HTTP 200 with the
 * {@link HealthSnapshot} JSON body. The handler always responds with
 * HTTP 200 — `'degraded'` is encoded in the body, never as a 5xx — so
 * that a Docker `HEALTHCHECK` using `curl --fail` treats the relay as
 * reachable even when no agents are connected. The orchestrator
 * inspects the JSON body for the actual health signal.
 *
 * Implements R1.7, R23.4.
 */
export function createHealthHandler(
  provider: HealthProvider,
): (req: Request, res: Response) => void {
  return function healthHandler(_req: Request, res: Response): void {
    const snapshot = buildHealthSnapshot(provider);
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(snapshot);
  };
}
