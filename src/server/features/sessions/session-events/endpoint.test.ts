import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { buildApp } from '../../../app.js';
import { registerSessionEvents } from './endpoint.js';

describe('session event WebSocket', () => {
  it('replays retained events in sequence and streams live events', async () => {
    const listeners = new Set<
      (event: {
        sessionId: string;
        sequence: number;
        type: string;
        occurredAt: string;
        payload: unknown;
      }) => void
    >();
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: 'test', protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
    });
    registerSessionEvents(app, {
      exists: (id) => id === 'session-1',
      since: () => [
        { sessionId: 'session-1', sequence: 1, type: 'replayed', occurredAt: 't', payload: {} },
      ],
      subscribe: (_id, listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/sessions/session-1/events?after=0`,
    );
    const first = once(socket, 'message').then(([data]) => JSON.parse(String(data)));
    await once(socket, 'open');
    expect(await first).toMatchObject({ type: 'relay.event', event: { sequence: 1 } });
    const second = once(socket, 'message').then(([data]) => JSON.parse(String(data)));
    listeners.forEach((listener) =>
      listener({ sessionId: 'session-1', sequence: 2, type: 'live', occurredAt: 't', payload: {} }),
    );
    expect(await second).toMatchObject({ type: 'relay.event', event: { sequence: 2 } });
    socket.close();
    await app.close();
  });
});
