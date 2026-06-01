/**
 * Unit tests for `relayClient` reconnect path.
 *
 * Covers:
 *  - First-connect retry budget (R4.3): up to 5 attempts with ≥2 s between.
 *  - Indefinite reconnect after first success (R21.1): exponential backoff
 *    1 s → 30 s, never gives up.
 *  - Re-emit of inflight records after reconnect (R21.3).
 *
 * _Implements: R21.1, R21.3, R21.5_
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  createRelayClient,
  type ExtensionRelayClientOptions,
  type ExtensionRelayClient,
} from '../src/relay/relayClient.js';
import type { Request } from '@kiro-gpt-bridge/shared';

// ─── Stub infrastructure ────────────────────────────────────────────────────

interface StubSocket {
  connected: boolean;
  emitter: EventEmitter;
  emitted: Array<{ event: string; args: unknown[] }>;
  disconnected: boolean;
  emit(event: string, ...args: unknown[]): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  once(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  removeAllListeners(): void;
  disconnect(): void;
}

function createStubSocket(): StubSocket {
  const emitter = new EventEmitter();
  const stub: StubSocket = {
    connected: true,
    emitter,
    emitted: [],
    disconnected: false,
    emit(event: string, ...args: unknown[]): void {
      stub.emitted.push({ event, args });
    },
    on(event: string, handler: (...args: unknown[]) => void): void {
      emitter.on(event, handler);
    },
    once(event: string, handler: (...args: unknown[]) => void): void {
      emitter.once(event, handler);
    },
    off(event: string, handler: (...args: unknown[]) => void): void {
      emitter.off(event, handler);
    },
    removeAllListeners(): void {
      emitter.removeAllListeners();
    },
    disconnect(): void {
      stub.disconnected = true;
      stub.connected = false;
    },
  };
  return stub;
}

function makeRequest(id: string): Request {
  return {
    protocolVersion: 1,
    requestId: id,
    clientId: 'test-client',
    sessionId: 'test-session',
    type: 'chat',
    prompt: 'hello',
    submittedAt: Date.now(),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('relayClient reconnect path', () => {
  let sockets: StubSocket[];
  let connectAttempts: number;
  let sleepCalls: number[];
  let resolveConnect: (() => void) | null;
  let rejectConnect: ((err: Error) => void) | null;

  function createTestClient(opts?: {
    failFirst?: number;
    failAll?: boolean;
  }): ExtensionRelayClient {
    sockets = [];
    connectAttempts = 0;
    sleepCalls = [];
    resolveConnect = null;
    rejectConnect = null;

    const failFirst = opts?.failFirst ?? 0;
    const failAll = opts?.failAll ?? false;

    const clientOpts: ExtensionRelayClientOptions = {
      relayUrl: 'ws://localhost:3001',
      kiroSecret: 'test-secret-16chars',
      clientVersion: '1.0.0',
      now: () => Date.now(),
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
      },
      ioFactory: (_url: string, _ioOpts: object): unknown => {
        connectAttempts += 1;
        const stub = createStubSocket();
        sockets.push(stub);

        if (failAll || connectAttempts <= failFirst) {
          // Simulate connect_error after a microtask
          setTimeout(() => {
            stub.emitter.emit('connect_error', new Error('connection refused'));
          }, 0);
        } else {
          // Simulate successful connect after a microtask
          setTimeout(() => {
            stub.emitter.emit('connect');
          }, 0);
        }
        return stub;
      },
    };

    return createRelayClient(clientOpts);
  }

  describe('first-connect retry budget (R4.3)', () => {
    it('succeeds on first attempt without retries', async () => {
      const client = createTestClient({ failFirst: 0 });
      await client.start();
      expect(connectAttempts).toBe(1);
      expect(sleepCalls).toHaveLength(0);
      expect(client.isConnected()).toBe(true);
      client.stop();
    });

    it('retries up to 5 times before rejecting', async () => {
      const client = createTestClient({ failAll: true });
      await expect(client.start()).rejects.toThrow();
      expect(connectAttempts).toBe(5);
    });

    it('succeeds on the 3rd attempt after 2 failures', async () => {
      const client = createTestClient({ failFirst: 2 });
      await client.start();
      expect(connectAttempts).toBe(3);
      expect(sleepCalls).toHaveLength(2);
      expect(client.isConnected()).toBe(true);
      client.stop();
    });

    it('enforces at least 2000 ms between first-connect retries', async () => {
      const client = createTestClient({ failFirst: 3 });
      await client.start();
      // All sleep delays should be >= 2000 ms per R4.3
      for (const delay of sleepCalls) {
        expect(delay).toBeGreaterThanOrEqual(2000);
      }
      client.stop();
    });
  });

  describe('indefinite reconnect after first success (R21.1)', () => {
    it('schedules reconnect on disconnect after first success', async () => {
      const client = createTestClient({ failFirst: 0 });
      await client.start();
      expect(client.isConnected()).toBe(true);

      // Simulate disconnect
      const firstSocket = sockets[0]!;
      firstSocket.emitter.emit('disconnect');

      // Wait for the reconnect loop to fire
      await new Promise((r) => setTimeout(r, 10));

      // A new socket should have been created
      expect(sockets.length).toBeGreaterThanOrEqual(2);
      client.stop();
    });

    it('uses exponential backoff on reconnect failures', async () => {
      let attemptCount = 0;
      const sleepDelays: number[] = [];

      const clientOpts: ExtensionRelayClientOptions = {
        relayUrl: 'ws://localhost:3001',
        kiroSecret: 'test-secret-16chars',
        clientVersion: '1.0.0',
        now: () => Date.now(),
        sleep: async (ms: number) => {
          sleepDelays.push(ms);
        },
        ioFactory: (_url: string, _ioOpts: object): unknown => {
          attemptCount += 1;
          const stub = createStubSocket();
          sockets.push(stub);

          if (attemptCount === 1) {
            // First connect succeeds
            setTimeout(() => stub.emitter.emit('connect'), 0);
          } else if (attemptCount <= 5) {
            // Reconnect attempts fail
            setTimeout(
              () =>
                stub.emitter.emit(
                  'connect_error',
                  new Error('connection refused'),
                ),
              0,
            );
          } else {
            // Eventually succeeds
            setTimeout(() => stub.emitter.emit('connect'), 0);
          }
          return stub;
        },
      };

      sockets = [];
      const client = createRelayClient(clientOpts);
      await client.start();

      // Trigger disconnect
      sockets[0]!.emitter.emit('disconnect');

      // Wait for reconnect loop to run through failures
      await new Promise((r) => setTimeout(r, 50));

      // Backoff delays should be non-decreasing (exponential)
      for (let i = 1; i < sleepDelays.length; i++) {
        expect(sleepDelays[i]!).toBeGreaterThanOrEqual(sleepDelays[i - 1]!);
      }
      // All delays should be capped at 30000
      for (const d of sleepDelays) {
        expect(d).toBeLessThanOrEqual(30000);
      }
      client.stop();
    });
  });

  describe('re-emit of inflight records after reconnect (R21.3)', () => {
    it('re-emits non-terminal requests on reconnect', async () => {
      let attemptCount = 0;
      const localSockets: StubSocket[] = [];

      const clientOpts: ExtensionRelayClientOptions = {
        relayUrl: 'ws://localhost:3001',
        kiroSecret: 'test-secret-16chars',
        clientVersion: '1.0.0',
        now: () => Date.now(),
        sleep: async () => {},
        ioFactory: (_url: string, _ioOpts: object): unknown => {
          attemptCount += 1;
          const stub = createStubSocket();
          localSockets.push(stub);
          setTimeout(() => stub.emitter.emit('connect'), 0);
          return stub;
        },
      };

      const client = createRelayClient(clientOpts);
      await client.start();

      // Submit two requests while connected
      const req1 = makeRequest('req-1');
      const req2 = makeRequest('req-2');
      client.submit(req1);
      client.submit(req2);

      // Verify they were emitted on the first socket
      const firstSocket = localSockets[0]!;
      const firstEmits = firstSocket.emitted.filter(
        (e) => e.event === 'request.submit',
      );
      expect(firstEmits).toHaveLength(2);

      // Simulate disconnect + reconnect
      firstSocket.emitter.emit('disconnect');
      await new Promise((r) => setTimeout(r, 20));

      // After reconnect, both requests should be re-emitted on the new socket
      const secondSocket = localSockets[1]!;
      expect(secondSocket).toBeDefined();
      const reEmits = secondSocket.emitted.filter(
        (e) => e.event === 'request.submit',
      );
      expect(reEmits).toHaveLength(2);

      // Verify reemitCount incremented
      const inflight = client.getInflight();
      for (const rec of inflight) {
        expect(rec.reemitCount).toBe(1);
      }

      client.stop();
    });

    it('re-emits cancel for records in cancelling state', async () => {
      let attemptCount = 0;
      const localSockets: StubSocket[] = [];

      const clientOpts: ExtensionRelayClientOptions = {
        relayUrl: 'ws://localhost:3001',
        kiroSecret: 'test-secret-16chars',
        clientVersion: '1.0.0',
        now: () => Date.now(),
        sleep: async () => {},
        ioFactory: (_url: string, _ioOpts: object): unknown => {
          attemptCount += 1;
          const stub = createStubSocket();
          localSockets.push(stub);
          setTimeout(() => stub.emitter.emit('connect'), 0);
          return stub;
        },
      };

      const client = createRelayClient(clientOpts);
      await client.start();

      // Submit and then cancel
      const req = makeRequest('req-cancel');
      client.submit(req);
      client.cancel('req-cancel');

      // Simulate disconnect + reconnect
      localSockets[0]!.emitter.emit('disconnect');
      await new Promise((r) => setTimeout(r, 20));

      // After reconnect, both submit and cancel should be re-emitted
      const secondSocket = localSockets[1]!;
      const submits = secondSocket.emitted.filter(
        (e) => e.event === 'request.submit',
      );
      const cancels = secondSocket.emitted.filter(
        (e) => e.event === 'request.cancel',
      );
      expect(submits).toHaveLength(1);
      expect(cancels).toHaveLength(1);

      client.stop();
    });
  });
});
