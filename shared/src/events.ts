/**
 * Closed list of every Socket.IO event name in the kiro-gpt-bridge protocol.
 *
 * Single source of truth for client/agent/relay handlers. The map is
 * `as const` so each value is a string-literal type and the union derived
 * below (`EventName`) is exhaustive.
 *
 * Implements: shared interface contract used by all three components
 *   (kiro-extension, relay-server, browser-agent). See design.md
 *   "Socket.IO Event Names".
 */
export const EV = {
  // ─── KIRO Extension <-> Relay ───
  REQUEST_SUBMIT: 'request.submit',
  REQUEST_CANCEL: 'request.cancel',
  REQUEST_STATUS: 'request.status',
  STREAM_CHUNK: 'stream.chunk',
  AGENT_STATUS: 'agent.status', // broadcast to clients
  SERVER_STATUS: 'server.status', // broadcast to clients

  // ─── Browser Agent <-> Relay ───
  AGENT_REGISTER: 'agent.register',
  AGENT_HEARTBEAT: 'agent.heartbeat',
  AGENT_DISPATCH: 'agent.dispatch', // server -> agent
  AGENT_CANCEL: 'agent.cancel', // server -> agent
  AGENT_ACK: 'agent.ack',
  AGENT_STATUS_FROM: 'agent.status_from', // agent -> server
} as const;

/** Union of every event name string in the {@link EV} map. */
export type EventName = (typeof EV)[keyof typeof EV];
