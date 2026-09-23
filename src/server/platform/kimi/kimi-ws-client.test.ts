/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsServerSocket } from 'ws';
import { KimiWsClient, type KimiWsEvent } from './kimi-ws-client.js';

let server: WebSocketServer | null = null;
afterEach(async () => {
  if (server) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => (server as WebSocketServer).close(() => resolve()));
    server = null;
  }
});

async function startFakeKimiSocket(
  onFrame: (socket: WsServerSocket, frame: Record<string, unknown>) => void,
): Promise<{ url: string; close(): void }> {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  server.on('connection', (socket) => {
    socket.on('message', (data) => onFrame(socket, JSON.parse(String(data))));
  });
  await new Promise<void>((resolve) => (server as WebSocketServer).once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      for (const socket of (server as WebSocketServer).clients) socket.terminate();
    },
  };
}

describe('KimiWsClient', () => {
  it('connects with the bearer subprotocol, subscribes, and receives session events', async () => {
    const seenSubprotocols: string[] = [];
    const fake = await startFakeKimiSocket((socket, frame) => {
      if (frame.type === 'client_hello') {
        socket.send(JSON.stringify({ type: 'server_hello' }));
        return;
      }
      if (frame.type === 'subscribe') {
        socket.send(JSON.stringify({ type: 'ack', id: frame.id, code: 0, msg: 'success' }));
        // Real kimi frames carry the event type at the top level.
        socket.send(
          JSON.stringify({
            type: 'assistant.delta',
            seq: 1,
            session_id: 'session_a',
            timestamp: '2026-09-22T00:00:00Z',
            payload: { agentId: 'agent_1', turnId: 7, delta: 'hi' },
          }),
        );
      }
    });
    // Record the negotiated subprotocol per connection.
    (
      server as unknown as {
        on(
          evt: string,
          cb: (s: WsServerSocket, req: { headers: Record<string, string> }) => void,
        ): void;
      }
    ).on('connection', (socket, request) => {
      seenSubprotocols.push(String(request.headers['sec-websocket-protocol']));
    });

    const client = new KimiWsClient(fake.url, 'secret-token');
    await client.connect();
    const events: KimiWsEvent[] = [];
    client.onEvent((event) => events.push(event));
    const ack = await client.subscribe(['session_a'], { session_a: { seq: 0 } });
    expect(ack.code).toBe(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant.delta');
    expect(events[0].payload).toMatchObject({ type: 'assistant.delta', delta: 'hi' });
    expect(seenSubprotocols.some((value) => value.includes('kimi-code.bearer.secret-token'))).toBe(
      true,
    );
    client.close();
  });

  it('correlates abort frames with their ack', async () => {
    const fake = await startFakeKimiSocket((socket, frame) => {
      if (frame.type === 'client_hello') {
        socket.send(JSON.stringify({ type: 'server_hello' }));
        return;
      }
      if (frame.type === 'abort') {
        expect(frame.payload).toEqual({ session_id: 'session_a', prompt_id: 'prompt_1' });
        socket.send(JSON.stringify({ type: 'ack', id: frame.id, code: 0 }));
      }
    });
    const client = new KimiWsClient(fake.url, 'token');
    await client.connect();
    const ack = await client.abort('session_a', 'prompt_1');
    expect(ack.code).toBe(0);
    client.close();
  });

  it('rejects requests while the socket is closed', async () => {
    const client = new KimiWsClient('http://127.0.0.1:1', 'token');
    await expect(client.subscribe(['session_a'])).rejects.toThrow('not open');
    await expect(client.abort('session_a', 'p')).rejects.toThrow('not open');
  });
});
