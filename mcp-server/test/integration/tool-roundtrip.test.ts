/**
 * Integration test: MCP tool roundtrip — task 23.8.
 *
 * Boots a fake Socket.IO relay (just enough to accept the KIRO
 * handshake and emit a single final {@link StreamChunk} carrying a
 * known PNG payload), connects the in-process MCP server to it via
 * the in-process MCP transport, and calls `generate_image`. The test
 * asserts the returned `savedPath` exists on disk under a temp
 * workspace and that its bytes are byte-equal to the fake image
 * emitted by the relay.
 *
 * Implements R31.3, R31.6.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  EV,
  base64Encode,
  type Request as WireRequest,
  type StreamChunk,
} from '@kiro-gpt-bridge/shared';

import { bootMcpInProcess, type McpHarness } from './_mcpHarness.js';

// ─── Fake image fixture ───────────────────────────────────────────────────

/**
 * Minimal valid 1x1 PNG byte sequence. Independent of any image
 * library so the test stays self-contained. The exact bytes are not
 * important — the test only requires byte-equality between what the
 * fake relay emits and what is saved on disk.
 *
 * (8-byte PNG signature + IHDR chunk + 1-pixel IDAT + IEND.)
 */
const FAKE_PNG_BYTES: Uint8Array = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d,                         // IHDR length
  0x49, 0x48, 0x44, 0x52,                         // "IHDR"
  0x00, 0x00, 0x00, 0x01,                         // width 1
  0x00, 0x00, 0x00, 0x01,                         // height 1
  0x08, 0x06, 0x00, 0x00, 0x00,                   // bit depth, color type, etc.
  0x1f, 0x15, 0xc4, 0x89,                         // CRC
  0x00, 0x00, 0x00, 0x0d,                         // IDAT length
  0x49, 0x44, 0x41, 0x54,                         // "IDAT"
  0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, // zlib-compressed pixel
  0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
  0x00, 0x00, 0x00, 0x00,                         // IEND length
  0x49, 0x45, 0x4e, 0x44,                         // "IEND"
  0xae, 0x42, 0x60, 0x82,                         // CRC
]);

// ─── Fake relay ───────────────────────────────────────────────────────────

/**
 * Boot a Socket.IO server on `127.0.0.1` at an OS-assigned port. The
 * server accepts every handshake (the test does not exercise auth) and
 * responds to a `request.submit` event by emitting a single
 * {@link StreamChunk} with `isFinal: true` carrying the supplied
 * image bytes. Returns the URL the MCP relay client should connect to
 * plus a teardown helper.
 */
async function bootFakeRelay(imageBytes: Uint8Array): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const httpServer: HttpServer = createHttpServer();
  const io: SocketIOServer = new SocketIOServer(httpServer, {
    // Match the production transport list so the engine.io polling
    // fallback never enters the picture and the test deterministically
    // exercises the websocket path.
    transports: ['websocket'],
    // Generous payload ceiling so the 25 MB MCP wire ceiling is not
    // accidentally tripped by a future larger fixture.
    maxHttpBufferSize: 100 * 1024 * 1024,
    // No CORS — we are only ever serving a localhost connection.
  });

  io.on('connection', (socket: Socket) => {
    socket.on(EV.REQUEST_SUBMIT, (req: WireRequest) => {
      // Drop into a microtask so the relay-client's pending promise
      // is registered before the chunk arrives.
      queueMicrotask(() => {
        const chunk: StreamChunk = {
          protocolVersion: 1,
          requestId: req.requestId,
          chunkIndex: 0,
          text: '',
          isFinal: true,
          mediaType: 'image/png',
          base64: base64Encode(imageBytes),
          status: 'completed',
        };
        socket.emit(EV.STREAM_CHUNK, chunk);
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = httpServer.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('fake relay failed to bind');
  }
  const url = `http://127.0.0.1:${addr.port}`;

  async function close(): Promise<void> {
    await new Promise<void>((resolve) => {
      io.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  }

  return { url, close };
}

// ─── Fixture ───────────────────────────────────────────────────────────────

let workspaceRoot: string;
let harness: McpHarness;
let relayCloser: () => Promise<void>;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'mcp-roundtrip-'));
  const relay = await bootFakeRelay(FAKE_PNG_BYTES);
  relayCloser = relay.close;
  harness = await bootMcpInProcess({
    relayUrl: relay.url,
    workspaceRoot,
  });
}, 30_000);

afterAll(async () => {
  if (harness !== undefined) {
    await harness.cleanup();
  }
  if (relayCloser !== undefined) {
    await relayCloser();
  }
  if (workspaceRoot !== undefined) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('MCP tool roundtrip — task 23.8', () => {
  it('generate_image saves the fake image bytes under the temp workspace', async () => {
    const result = await harness.callTool('generate_image', {
      prompt: 'a small test image with a friendly subject',
      asset_category: 'illustration',
      framework: 'unknown',
    });

    expect(result.isError).toBe(false);
    expect(result.payload.ok).toBe(true);

    // R31.6 — success result shape.
    expect(typeof result.payload.savedPath).toBe('string');
    expect(result.payload.mimeType).toBe('image/png');
    expect(typeof result.payload.prompt).toBe('string');
    expect(typeof result.payload.requestId).toBe('string');
    expect(result.payload.assetCategory).toBe('illustration');

    const savedPath = result.payload.savedPath as string;

    // The saved path must live somewhere under the test workspace.
    const rel = path.relative(workspaceRoot, savedPath);
    expect(rel.startsWith('..')).toBe(false);
    expect(path.isAbsolute(rel)).toBe(false);

    // File exists on disk.
    expect(existsSync(savedPath)).toBe(true);

    // Bytes match the fake image emitted by the relay.
    const onDisk = readFileSync(savedPath);
    const expected = Buffer.from(FAKE_PNG_BYTES);
    expect(onDisk.equals(expected)).toBe(true);
  }, 30_000);
});
