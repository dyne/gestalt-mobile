/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { previewHandoffPath } from '../../../shared/contracts/preview.js';
import {
  previewSessionLifetime,
  type PreviewService,
} from '../../features/previews/application/service.js';
import { cookieName, previewCookie, proxyHttp, proxyWebSocket, rejectUpgrade } from './proxy.js';

type Connection = { viewer: string; disconnect(): void };
type GatewayOptions = { origin: string; port: number; targetPort: number };

export function createPreviewGateway(
  options: GatewayOptions,
  service: Pick<PreviewService, 'exchange' | 'authorized'>,
) {
  const origin = new URL(options.origin);
  const target = { port: options.targetPort, origin };
  const connections = new Set<Connection>();
  let expiryCheck: NodeJS.Timeout | undefined;

  function track(viewer: string) {
    return (disconnect: () => void) => {
      const connection = { viewer, disconnect };
      connections.add(connection);
      return () => connections.delete(connection);
    };
  }

  function validRequest(request: IncomingMessage): boolean {
    return (
      request.headers.host === origin.host &&
      typeof request.url === 'string' &&
      request.url.startsWith('/') &&
      !request.url.startsWith('//')
    );
  }

  const server = createServer((request, response) => {
    if (!validRequest(request)) return text(response, 421, 'Unknown preview host.');
    if (request.url === previewHandoffPath) {
      if (request.method === 'GET') return handoff(response);
      if (request.method === 'POST' && request.headers.origin === origin.origin) {
        return exchange(request, response, (code) => service.exchange(code)).catch(() => {
          if (!response.destroyed) text(response, 400, 'Invalid preview authorization.');
        });
      }
      return text(response, 403, 'Preview authorization must come from the preview site.');
    }
    if (
      !allowedHttpOrigin(request, origin.origin) ||
      request.headers['service-worker'] ||
      request.headers['sec-fetch-dest'] === 'serviceworker'
    )
      return text(response, 403, 'This preview request is forbidden.');
    const viewer = readViewer(request);
    if (!viewer || !service.authorized(viewer))
      return text(response, 401, 'Open the preview from your Gestalt session.');
    proxyHttp(request, response, target, track(viewer));
  });

  server.on('upgrade', (request, socket, head) => {
    const viewer = readViewer(request);
    if (
      !validRequest(request) ||
      request.url === previewHandoffPath ||
      request.headers.upgrade?.toLowerCase() !== 'websocket' ||
      request.headers.origin !== origin.origin ||
      !viewer ||
      !service.authorized(viewer)
    ) {
      socket.once('error', () => socket.destroy());
      rejectUpgrade(socket, '401 Unauthorized');
      return;
    }
    proxyWebSocket(request, socket, head, target, track(viewer));
  });

  return {
    async start() {
      const listening = once(server, 'listening');
      server.listen(options.port, '127.0.0.1');
      await listening;
      expiryCheck = setInterval(() => {
        for (const connection of connections) {
          if (!service.authorized(connection.viewer)) connection.disconnect();
        }
      }, 1000).unref();
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Preview listener has no port');
      return address.port;
    },
    async close() {
      clearInterval(expiryCheck);
      for (const connection of connections) connection.disconnect();
      if (server.listening) {
        const closed = once(server, 'close');
        server.close();
        server.closeAllConnections();
        await closed;
      }
    },
  };
}

function readViewer(request: IncomingMessage): string | undefined {
  const pair = request.headers.cookie
    ?.split(';')
    .filter((part) => cookieName(part) === previewCookie);
  if (pair?.length !== 1) return;
  const token = pair[0].trim().slice(previewCookie.length + 1);
  return validToken(token) ? token : undefined;
}

function validToken(token: string): boolean {
  return /^[\w-]{43}$/.test(token);
}

function allowedHttpOrigin(request: IncomingMessage, origin: string): boolean {
  if (request.headers.origin && request.headers.origin !== origin) return false;
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return request.headers.origin === origin;
  const site = request.headers['sec-fetch-site'];
  return (
    !site ||
    site === 'none' ||
    site === 'same-origin' ||
    (request.headers['sec-fetch-mode'] === 'navigate' &&
      request.headers['sec-fetch-dest'] === 'document')
  );
}

async function exchange(
  request: IncomingMessage,
  response: ServerResponse,
  consume: (code: string) => string | undefined,
): Promise<void> {
  let body = '';
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    body += String(chunk);
    if (body.length > 43) {
      text(response, 400, 'Invalid preview authorization.');
      request.resume();
      return;
    }
  }
  const viewer = validToken(body) ? consume(body) : undefined;
  if (!viewer) {
    text(response, 401, 'Preview authorization expired. Open the preview again from Gestalt.');
    return;
  }
  response
    .writeHead(204, {
      'cache-control': 'no-store',
      'set-cookie': `${previewCookie}=${viewer}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${previewSessionLifetime}`,
    })
    .end();
}

function text(response: ServerResponse, status: number, message: string) {
  response
    .writeHead(status, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
    })
    .end(message);
}

function handoff(response: ServerResponse): void {
  const nonce = randomBytes(16).toString('base64');
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  }).end(`<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Gestalt Preview</title>
<p id="status">Open the preview from your Gestalt session.</p>
<script nonce="${nonce}">
const code = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
if (code) {
  const status = document.getElementById('status');
  status.textContent = 'Opening preview…';
  fetch(location.pathname, { method: 'POST', body: code }).then((result) => {
    if (result.ok) location.replace('/');
    else status.textContent = 'Authorization expired. Open the preview again from Gestalt.';
  }).catch(() => {
    status.textContent = 'Could not connect. Open the preview again from Gestalt.';
  });
}
</script></html>`);
}
