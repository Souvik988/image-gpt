import { describe, it, expect } from 'vitest';
import { EV, type EventName } from '../src/events.js';

/**
 * Snapshot tests for `shared/src/events.ts`. Locks the closed Socket.IO
 * event-name enum so any rename, addition, or removal triggers an
 * explicit test diff rather than silently breaking cross-component
 * routing. Every value here is a wire literal shared by the relay,
 * browser-agent, and kiro-extension. Implements: R26.5 / R26.6
 * (closed-enum guarantee for the shared interface contract).
 */
describe('EV wire contract', () => {
  it('matches the documented closed map exactly', () => {
    expect(EV).toEqual({
      REQUEST_SUBMIT: 'request.submit',
      REQUEST_CANCEL: 'request.cancel',
      REQUEST_STATUS: 'request.status',
      STREAM_CHUNK: 'stream.chunk',
      AGENT_STATUS: 'agent.status',
      SERVER_STATUS: 'server.status',
      AGENT_REGISTER: 'agent.register',
      AGENT_HEARTBEAT: 'agent.heartbeat',
      AGENT_DISPATCH: 'agent.dispatch',
      AGENT_CANCEL: 'agent.cancel',
      AGENT_ACK: 'agent.ack',
      AGENT_STATUS_FROM: 'agent.status_from',
    });
  });

  it('matches the inline snapshot of the closed enum', () => {
    expect(EV).toMatchInlineSnapshot(`
      {
        "AGENT_ACK": "agent.ack",
        "AGENT_CANCEL": "agent.cancel",
        "AGENT_DISPATCH": "agent.dispatch",
        "AGENT_HEARTBEAT": "agent.heartbeat",
        "AGENT_REGISTER": "agent.register",
        "AGENT_STATUS": "agent.status",
        "AGENT_STATUS_FROM": "agent.status_from",
        "REQUEST_CANCEL": "request.cancel",
        "REQUEST_STATUS": "request.status",
        "REQUEST_SUBMIT": "request.submit",
        "SERVER_STATUS": "server.status",
        "STREAM_CHUNK": "stream.chunk",
      }
    `);
  });

  it('contains exactly 12 distinct event names', () => {
    const values = Object.values(EV);
    expect(values.length).toBe(12);
    expect(new Set<string>(values).size).toBe(values.length);
  });

  it('every value is a dotted lowercase token (channel.name shape)', () => {
    // Sanity check — the relay's handler tables key off these strings, so
    // accidental whitespace or casing would break routing silently.
    const wireRe = /^[a-z]+(\.[a-z_]+)+$/;
    for (const value of Object.values(EV)) {
      expect(value, `event name "${value}" must match ${wireRe}`).toMatch(wireRe);
    }
  });

  it('exposes the EventName union covering every map value', () => {
    // Compile-time check via a const assertion table — every key must be
    // assignable to EventName.
    const sample: Record<string, EventName> = {
      submit: EV.REQUEST_SUBMIT,
      cancel: EV.REQUEST_CANCEL,
      status: EV.REQUEST_STATUS,
      chunk: EV.STREAM_CHUNK,
      agentStatus: EV.AGENT_STATUS,
      serverStatus: EV.SERVER_STATUS,
      register: EV.AGENT_REGISTER,
      heartbeat: EV.AGENT_HEARTBEAT,
      dispatch: EV.AGENT_DISPATCH,
      agentCancel: EV.AGENT_CANCEL,
      ack: EV.AGENT_ACK,
      agentStatusFrom: EV.AGENT_STATUS_FROM,
    };
    expect(Object.keys(sample).length).toBe(12);
  });
});
