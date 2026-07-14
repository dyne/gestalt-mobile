import type { FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';

import { replayOrResync } from '../../../platform/events/replay.js';
import { isSlowClient } from '../../../platform/events/slow-client.js';
import { installWebSocketHeartbeat } from '../../../platform/events/websocket-heartbeat.js';
import type { SessionEvent } from '../../../../shared/contracts/session-event.js';

export function registerSessionEvents(
  app: FastifyInstance,
  deps: {
    exists(id: string): boolean;
    since(id: string, after: number): SessionEvent[];
    subscribe(id: string, listener: (event: SessionEvent) => void): () => void;
  },
): void {
  const server = new WebSocketServer({ noServer: true });
  app.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://relay.invalid');
    const match = /^\/api\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    const after = Number(url.searchParams.get('after') ?? '0');
    if (!match || !Number.isSafeInteger(after) || after < 0 || !deps.exists(match[1])) {
      socket.destroy();
      return;
    }
    server.handleUpgrade(request, socket, head, (connection) => {
      const sessionId = match[1]!;
      const send = (event: SessionEvent) => {
        if (isSlowClient(connection.bufferedAmount)) return connection.close(1013, 'slow client');
        connection.send(JSON.stringify({ type: 'relay.event', event }));
      };
      const replay = replayOrResync(deps.since(sessionId, after), after);
      if (replay.kind === 'resync') {
        connection.send(JSON.stringify({ type: 'relay.resyncRequired' }));
        connection.close();
        return;
      }
      replay.events.forEach(send);
      const unsubscribe = deps.subscribe(sessionId, send);
      const removeHeartbeat = installWebSocketHeartbeat(connection);
      connection.on('close', () => {
        removeHeartbeat();
        unsubscribe();
      });
    });
  });
  app.addHook('onClose', async () => server.close());
}
