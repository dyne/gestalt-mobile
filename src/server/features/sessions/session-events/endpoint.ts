/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

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
    /** Set only by the composition root when the authorization boundary is installed. */
    publicOrigin?: string;
    authorized?: (cookieHeader: string | undefined) => boolean;
    heartbeatIntervalMs?: number;
    bufferedAmount?: (connection: { bufferedAmount: number }) => number;
  },
): void {
  const server = new WebSocketServer({ noServer: true });
  app.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://relay.invalid');
    const match = /^\/api\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    const after = Number(url.searchParams.get('after') ?? '0');
    if (
      !match ||
      !Number.isSafeInteger(after) ||
      after < 0 ||
      (deps.publicOrigin !== undefined && request.headers.origin !== deps.publicOrigin) ||
      (deps.authorized !== undefined && !deps.authorized(request.headers.cookie)) ||
      !deps.exists(match[1])
    ) {
      socket.destroy();
      return;
    }
    server.handleUpgrade(request, socket, head, (connection) => {
      const sessionId = match[1]!;
      const sent = new Set<number>();
      const send = (event: SessionEvent) => {
        // A subscription intentionally overlaps the durable replay.  The sequence
        // is the authoritative identity of an event, so overlap is harmless.
        if (event.sessionId !== sessionId || !Number.isSafeInteger(event.sequence) || event.sequence < 1)
          return;
        if (sent.has(event.sequence)) return;
        sent.add(event.sequence);
        if (isSlowClient(deps.bufferedAmount?.(connection) ?? connection.bufferedAmount)) return connection.close(1013, 'slow client');
        connection.send(JSON.stringify({ type: 'relay.event', event }));
      };
      let unsubscribe: (() => void) | undefined;
      let removeHeartbeat: (() => void) | undefined;
      let replaying = true;
      const liveDuringReplay: SessionEvent[] = [];
      const cleanup = () => {
        removeHeartbeat?.();
        removeHeartbeat = undefined;
        unsubscribe?.();
        unsubscribe = undefined;
      };
      try {
        // Subscribe before reading the journal: every event after this point is
        // either in replay or delivered live, and the sequence de-duplicates it.
        unsubscribe = deps.subscribe(sessionId, (event) => {
          if (replaying) liveDuringReplay.push(event);
          else send(event);
        });
        const replay = replayOrResync(deps.since(sessionId, after), after);
        if (replay.kind === 'resync') {
          const currentSequence = deps.since(sessionId, 0).at(-1)?.sequence ?? after;
          connection.send(JSON.stringify({ type: 'relay.resyncRequired', currentSequence }));
          cleanup();
          connection.close();
          return;
        }
        replay.events.forEach(send);
        replaying = false;
        liveDuringReplay.sort((left, right) => left.sequence - right.sequence).forEach(send);
      } catch {
        cleanup();
        connection.close();
        return;
      }
      removeHeartbeat = installWebSocketHeartbeat(
        connection,
        deps.heartbeatIntervalMs ?? 25_000,
        () => deps.authorized?.(request.headers.cookie) ?? true,
      );
      connection.on('close', cleanup);
    });
  });
  app.addHook('onClose', async () => server.close());
}
