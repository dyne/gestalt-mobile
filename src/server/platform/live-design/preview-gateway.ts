/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import cookie from '@fastify/cookie';
import fastify from 'fastify';
import { request as upstreamRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import type { Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import type {
  PreviewGrantDependencies,
  PreviewInstance,
} from '../../features/live-design/application/ports.js';
import type { PreviewOriginAssignment } from '../../features/live-design/application/routes.js';
import { registerPreviewExchange } from '../../features/live-design/exchange/endpoint.js';
import { LiveAuthError } from '../../features/live-design/application/grants.js';
import { exchangeDocument } from './exchange-document.js';
import {
  PreviewProxyAuthorization,
  stripPreviewResponseHeaders,
} from './preview-proxy-authorization.js';
import { PreviewConnections } from './preview-connections.js';
import type { PreviewConnectionPermit } from './preview-connections.js';
import { RegisteredPreviewTargets } from './preview-targets.js';
import {
  ownedPreviewHttp,
  relayPreviewHttpBody,
  OwnedPreviewWebSockets,
  relayPreviewWebSockets,
} from './preview-stream-transports.js';

/** One private loopback listener per durable origin/instance. No request-selected upstream or binding. */
export async function createPreviewGateway(options: {
  deps: PreviewGrantDependencies;
  instance: PreviewInstance;
  assignment: PreviewOriginAssignment;
  targets: RegisteredPreviewTargets;
  registrationId: string;
  connections: PreviewConnections;
}) {
  const { deps, instance, assignment, targets, registrationId, connections } = options;
  if (assignment.origin !== instance.previewOrigin) throw new Error('LIVE_ORIGIN_MISMATCH');
  const target = targets.read(registrationId, assignment.canonicalAppRoot);
  const authorization = new PreviewProxyAuthorization(deps, instance, connections);
  const app = fastify({ logger: false, trustProxy: false });
  const inboundSockets = new Set<Socket>();
  let closing = false;
  app.server.on('connection', (socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    inboundSockets.add(socket);
    socket.once('close', () => inboundSockets.delete(socket));
  });
  // Includes denied and pending upgrades, which are not WebSocketServer clients.
  app.addHook('preClose', async () => {
    closing = true;
    for (const socket of inboundSockets) socket.destroy();
  });
  await app.register(cookie);
  registerPreviewExchange(app, {
    ...deps,
    boundOrigin: assignment.origin,
    document: exchangeDocument(deps.mobileOrigin),
  });
  app.addHook('onRequest', async (req, reply) => {
    if (!loopback(req.raw)) return reply.code(403).send();
  });
  await app.register(async (proxy) => {
    // Keep upstream bodies as streams. Exchange endpoints retain their normal JSON parser.
    proxy.removeAllContentTypeParsers();
    proxy.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    proxy.all('/*', async (req, reply) => {
      let upstream: ReturnType<typeof upstreamRequest> | undefined;
      let permit: PreviewConnectionPermit | undefined;
      try {
        const authorized = authorization.open(
          {
            method: req.method,
            target: req.raw.url ?? '/',
            headers: req.headers,
            websocket: false,
          },
          ownedPreviewHttp(reply.raw, () => upstream?.destroy()),
        );
        permit = authorized;
        // Re-check trusted registration before each connection, including after controller recovery.
        const current = targets.read(registrationId, assignment.canonicalAppRoot);
        const route = helperRoute(req.raw.url ?? '/');
        const port = route.helper ? current.helperPort : current.appPort;
        reply.hijack();
        upstream = upstreamRequest(
          {
            host: '127.0.0.1',
            port,
            method: req.method,
            path: route.path,
            agent: false,
            headers: { ...authorized.upstreamHeaders, host: `127.0.0.1:${port}` },
          },
          (response) => {
            if (!authorized.active()) {
              response.destroy();
              return;
            }
            reply.raw.writeHead(
              response.statusCode ?? 502,
              stripPreviewResponseHeaders(response.headers),
            );
            relayPreviewHttpBody(authorized, response, reply.raw);
          },
        );
        upstream.once('error', () => {
          authorized.release();
          reply.raw.destroy();
        });
        reply.raw.once('close', () => {
          authorized.release();
          upstream?.destroy();
        });
        ((req.body as Readable | undefined) ?? req.raw).pipe(upstream);
      } catch (error) {
        permit?.release();
        const status = error instanceof LiveAuthError ? error.status : 503;
        reply
          .code(status)
          .headers({
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
            'content-security-policy':
              "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
            'cross-origin-resource-policy': 'same-origin',
            'x-frame-options': 'DENY',
            'x-content-type-options': 'nosniff',
          })
          .type('text/html')
          .send(deniedDocument);
      }
    });
  });
  const sockets = new WebSocketServer({ noServer: true });
  app.server.on('upgrade', (req, socket, head) => {
    let upstream: WebSocket | undefined;
    let permit: PreviewConnectionPermit | undefined;
    const owned = new OwnedPreviewWebSockets(() => {
      upstream?.terminate();
      socket.destroy();
    });
    try {
      if (!loopback(req) || helperRoute(req.url ?? '/').helper)
        throw new LiveAuthError('LIVE_INVALID_REQUEST', 403);
      const authorized = authorization.open(
        {
          method: req.method ?? 'GET',
          target: req.url ?? '/',
          headers: req.headers,
          websocket: true,
        },
        owned,
      );
      permit = authorized;
      const current = targets.read(registrationId, assignment.canonicalAppRoot);
      const protocols = (req.headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const headers: Record<string, string> = {
        ...authorized.upstreamHeaders,
        host: `127.0.0.1:${current.appPort}`,
      };
      delete headers['sec-websocket-protocol'];
      upstream = new WebSocket(`ws://127.0.0.1:${current.appPort}${req.url}`, protocols, {
        headers,
      });
      owned.bind(upstream);
      upstream.once('open', () => {
        if (!authorized.active()) {
          upstream?.terminate();
          socket.destroy();
          return;
        }
        sockets.handleUpgrade(req, socket, head, (client) => {
          if (!authorized.active()) {
            client.terminate();
            return;
          }
          owned.bind(client);
          relayPreviewWebSockets(authorized, client, upstream!);
        });
      });
      upstream.once('error', () => {
        authorized.release();
        socket.destroy();
      });
      socket.once('close', () => {
        authorized.release();
        upstream?.terminate();
      });
    } catch (error) {
      permit?.release();
      const status = error instanceof LiveAuthError ? error.status : 503;
      socket.end(
        `HTTP/1.1 ${status} Denied\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`,
        () => socket.destroy(),
      );
    }
  });
  app.addHook('onClose', async () => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
  });
  return {
    app,
    async listen() {
      await app.listen({ host: '127.0.0.1', port: target.gatewayPort });
    },
    async close() {
      await app.close();
    },
  };
}
function helperRoute(path: string): { helper: boolean; path: string } {
  const helper = path.startsWith('/__gestalt_live/');
  return { helper, path: helper ? path.slice('/__gestalt_live'.length) : path };
}
function loopback(request: IncomingMessage): boolean {
  return (
    request.socket.remoteAddress === '127.0.0.1' && request.socket.localAddress === '127.0.0.1'
  );
}
const deniedDocument = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Preview unavailable</title><style>body{margin:0;background:#151a22;color:#eef2f7;font:100%/1.6 system-ui,sans-serif;min-height:100vh;display:grid;place-items:center}main{padding:2rem;max-width:32rem}h1{font-size:1.5rem}p{color:#b9c4d0}</style><main><h1>Preview unavailable</h1><p>Open this preview from Gestalt Mobile.</p></main></html>`;
