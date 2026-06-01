/**
 * Docker Compose smoke test — task 21.5.
 *
 * Validates the workspace-root `docker-compose.yml` by running
 * `docker compose config` (parse + interpolate, no build), then builds
 * and runs the relay container, and curls `/health` to confirm the
 * `HEALTHCHECK` directive is active and the service is reachable.
 *
 * This file is named `*.slow.test.ts` so the default `vitest.config.ts`
 * excludes it; it runs only under `npm run test:slow` (which uses
 * `vitest.config.slow.ts` with a 5-minute test timeout — appropriate
 * for a clean image build on a cold host).
 *
 * Special case per the spec instruction: the test SKIPS itself with a
 * console warning when `docker` is not on PATH. That keeps developer
 * machines without Docker green for the slow suite while CI runs that
 * have Docker get the full coverage.
 *
 * Implements: R25.1 (compose file is the canonical deployment unit),
 * R25.3 (HEALTHCHECK directive responds 200 on /health).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Absolute path to the workspace root — the directory containing the
 * `docker-compose.yml` file under test.
 */
const WORKSPACE_ROOT: string = path.resolve(__dirname, '..', '..');

/**
 * Container name used for the relay service. Distinct from any name a
 * developer's local stack might use so we never clobber a running
 * service.
 */
const CONTAINER_NAME: string = 'kiro-gpt-bridge-e2e-docker-test';

/**
 * Host port we map the relay's container port 3001 to. Picked outside
 * the common dev range to avoid collisions with a developer's running
 * relay.
 */
const HOST_PORT: number = 3601;

/**
 * Probe `docker --version`. Returns `{ ok: true }` iff `docker` is on
 * PATH AND a daemon is reachable (the second test is a `docker info`
 * call; `docker --version` succeeds even when the daemon is down).
 */
function dockerAvailable(): { ok: true } | { ok: false; reason: string } {
  const ver = spawnSync('docker', ['--version'], {
    encoding: 'utf8',
    shell: false,
  });
  if (ver.error !== undefined) {
    return { ok: false, reason: `docker not on PATH: ${ver.error.message}` };
  }
  if (ver.status !== 0) {
    return { ok: false, reason: `docker --version exited ${ver.status}` };
  }
  const info = spawnSync('docker', ['info'], {
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
  });
  if (info.error !== undefined || info.status !== 0) {
    return {
      ok: false,
      reason: 'docker daemon not reachable',
    };
  }
  return { ok: true };
}

/**
 * Run `docker compose config` to parse + interpolate the file. Returns
 * the rendered config (stdout) on success; throws on validation error.
 *
 * Implements R25.1.
 */
function dockerComposeConfig(): string {
  const result = spawnSync(
    'docker',
    ['compose', '-f', 'docker-compose.yml', 'config'],
    {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
      shell: false,
      env: {
        ...process.env,
        // The compose file requires KIRO_SECRET and AGENT_SECRET; supply
        // throwaway test values that satisfy the 16–256 char rule.
        KIRO_SECRET: 'docker-test-kiro-secret-1234567890',
        AGENT_SECRET: 'docker-test-agent-secret-1234567890',
      },
      timeout: 30_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `docker compose config failed (status=${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout;
}

let dockerStatus: { ok: true } | { ok: false; reason: string };
let composeConfigOutput: string | null = null;
let containerStarted = false;

beforeAll(() => {
  dockerStatus = dockerAvailable();
  if (!dockerStatus.ok) {
    // eslint-disable-next-line no-console -- the spec instruction calls for an explicit console warning when docker is unavailable so CI logs surface the skip clearly (R25.1/R25.3 dev-machine skip path)
    console.warn(
      `[task 21.5] Skipping docker compose smoke test: ${dockerStatus.reason}`,
    );
    return;
  }
  composeConfigOutput = dockerComposeConfig();
});

afterAll(() => {
  if (containerStarted) {
    // Best-effort tear-down: remove the named container so we never
    // leak a long-running process if the test crashed mid-flight.
    spawnSync('docker', ['rm', '-f', CONTAINER_NAME], {
      encoding: 'utf8',
      shell: false,
      timeout: 30_000,
    });
    containerStarted = false;
  }
});

describe('e2e docker compose smoke (task 21.5)', () => {
  it('docker compose config validates docker-compose.yml', () => {
    if (!dockerStatus.ok) {
      // The beforeAll already logged the skip reason; we simply
      // pass-through here so the test reporter doesn't report a
      // failure on a Docker-less machine.
      expect(true).toBe(true);
      return;
    }
    expect(composeConfigOutput).not.toBeNull();
    // The rendered config must declare the `relay` service — the
    // canonical deployment unit per R25.1 — and surface the
    // healthcheck per R25.3.
    expect(composeConfigOutput ?? '').toMatch(/services:[\s\S]*relay:/);
    expect(composeConfigOutput ?? '').toContain('healthcheck');
  });

  it('builds and runs the relay container; /health responds 200', async () => {
    if (!dockerStatus.ok) {
      expect(true).toBe(true);
      return;
    }

    // 1) Build the relay image. Tag it with a unique name so we can
    // remove it cleanly afterwards.
    const tag: string = `${CONTAINER_NAME}:latest`;
    const build = spawnSync(
      'docker',
      ['build', '-t', tag, '-f', 'relay-server/Dockerfile', '.'],
      {
        cwd: WORKSPACE_ROOT,
        encoding: 'utf8',
        shell: false,
        timeout: 240_000,
      },
    );
    if (build.status !== 0) {
      throw new Error(
        `docker build failed (status=${build.status}): ${build.stderr}`,
      );
    }

    // 2) Remove any stale container of the same name (defensive).
    spawnSync('docker', ['rm', '-f', CONTAINER_NAME], {
      encoding: 'utf8',
      shell: false,
      timeout: 30_000,
    });

    // 3) Run the container detached. The compose file's healthcheck is
    // the value of record (R25.3); here we directly hit /health to
    // verify reachability and content type.
    const run = spawnSync(
      'docker',
      [
        'run',
        '-d',
        '--name',
        CONTAINER_NAME,
        '-p',
        `${HOST_PORT}:3001`,
        '-e',
        'KIRO_SECRET=docker-test-kiro-secret-1234567890',
        '-e',
        'AGENT_SECRET=docker-test-agent-secret-1234567890',
        tag,
      ],
      {
        cwd: WORKSPACE_ROOT,
        encoding: 'utf8',
        shell: false,
        timeout: 30_000,
      },
    );
    if (run.status !== 0) {
      throw new Error(
        `docker run failed (status=${run.status}): ${run.stderr}`,
      );
    }
    containerStarted = true;

    // 4) Poll /health until it responds 200 or 60 s elapses.
    const deadline = Date.now() + 60_000;
    let lastErr: string = '';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${HOST_PORT}/health`);
        if (res.status === 200) {
          const body = (await res.json()) as Record<string, unknown>;
          // R25.3 — /health must return a JSON snapshot. Status may be
          // either `ok` (highly unlikely in a no-agents container) or
          // `degraded` (expected when the agent slot is empty); both
          // are HTTP 200 by design.
          expect(typeof body.status).toBe('string');
          return;
        }
        lastErr = `status=${res.status}`;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 500);
        t.unref?.();
      });
    }
    throw new Error(`/health never returned 200 within 60 s: ${lastErr}`);
  });
});
