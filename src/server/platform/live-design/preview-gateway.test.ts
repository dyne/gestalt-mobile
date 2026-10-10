/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, expect, test } from 'vitest';
import { createServer, request } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { previewAuthFixture, origin } from '../../features/live-design/preview-auth.fixture.js';
import { createPreviewGateway } from './preview-gateway.js';
import { RegisteredPreviewTargets } from './preview-targets.js';
import { freePort } from './caddy-routes.fixture.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const auth = await previewAuthFixture(cleanup);
  const requests: { path: string; body: string; headers: Record<string, unknown> }[] = [];
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url!, body, headers: req.headers });
    if (req.url === '/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: connected\n\n');
    } else {
      res.writeHead(200, { 'set-cookie': 'project=secret', 'access-control-allow-origin': '*' });
      res.end(body || req.url);
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('No upstream address');
  const helperPort = await freePort();
  const helper = createServer(
    upstream.listeners('request')[0] as Parameters<typeof createServer>[0],
  );
  await new Promise<void>((resolve) => helper.listen(helperPort, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => helper.close(() => resolve())));
  const websocket = new WebSocketServer({ server: upstream });
  websocket.on('connection', (peer, req) => {
    requests.push({ path: req.url!, body: 'websocket', headers: req.headers });
    peer.on('message', (data) => peer.send(data));
  });
  cleanup.push(() => {
    for (const peer of websocket.clients) peer.terminate();
    websocket.close();
  });
  const targets = new RegisteredPreviewTargets();
  const gatewayPort = await freePort();
  const registrationId = targets.register({
    appRoot: auth.home,
    appPort: address.port,
    helperPort,
    gatewayPort,
  });
  const gateway = await createPreviewGateway({
    deps: auth.deps,
    instance: {
      relayId: 'relay',
      appId: 'app',
      liveId: 'live',
      generation: 1,
      previewOrigin: origin,
    },
    assignment: { canonicalAppRoot: auth.home, origin, port: 9443, serverId: 'fixture' },
    targets,
    registrationId,
    connections: auth.connections,
  });
  await gateway.listen();
  cleanup.push(() => gateway.close());
  const grant = (await auth.launch()).json();
  const exchange = await auth.exchange({ grant: grant.grant, grantId: grant.grantId });
  expect(exchange.statusCode).toBe(201);
  const cookie = String(exchange.headers['set-cookie']).split(';')[0]!;
  const headers = {
    host: new URL(origin).host,
    origin,
    cookie,
    'sec-fetch-site': 'same-origin',
    authorization: 'Bearer Mobile-secret',
    'x-forwarded-host': 'forged.example.test',
  };
  async function send(path: string, body?: string, extra = {}) {
    return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port: gatewayPort,
            path,
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              ...headers,
              ...(body === undefined
                ? {}
                : {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                  }),
              ...extra,
            },
          },
          (res) => {
            let result = '';
            res.on('data', (chunk) => (result += chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode!, body: result, headers: res.headers }),
            );
          },
        );
        req.on('error', reject);
        req.end(body);
      },
    );
  }
  return { ...auth, gateway, gatewayPort, headers, targets, registrationId, requests, send };
}

test('binds registered app/helper targets, relays JSON bodies and strips credentials and unsafe responses', async () => {
  const f = await fixture();
  const denied = await f.send('/@vite/client', undefined, { cookie: '' });
  expect(denied.status).toBe(401);
  expect(f.requests).toHaveLength(0);
  const helper = await f.send('/__gestalt_live/events', '{"event":"picked"}');
  expect(helper.status).toBe(200);
  expect(helper.body).toBe('{"event":"picked"}');
  expect(f.requests[0]?.path).toBe('/events');
  expect(f.requests[0]?.headers).not.toHaveProperty('cookie');
  expect(f.requests[0]?.headers).not.toHaveProperty('authorization');
  expect(f.requests[0]?.headers).not.toHaveProperty('x-forwarded-host');
  expect(helper.headers).not.toHaveProperty('set-cookie');
  expect(helper.headers).not.toHaveProperty('access-control-allow-origin');
  expect(helper.headers['cross-origin-resource-policy']).toBe('same-origin');
  expect((await f.send('/src/main.js')).body).toBe('/src/main.js');
  f.targets.unregister(f.registrationId);
  expect((await f.send('/')).status).toBe(503);
  expect(f.connections.size).toBe(0);
});

test('authorizes the actual HMR upgrade and closes its transport before revocation returns', async () => {
  const f = await fixture();
  const socket = new WebSocket(`ws://127.0.0.1:${f.gatewayPort}/?token=vite`, 'vite-hmr', {
    headers: f.headers,
  });
  cleanup.push(() => socket.terminate());
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const echoed = new Promise<string>((resolve) =>
    socket.once('message', (data) => resolve(String(data))),
  );
  socket.send('actual HMR frame');
  expect(await echoed).toBe('actual HMR frame');
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  await f.connections.revoke({ liveId: 'live' });
  await closed;
  expect(socket.readyState).toBe(WebSocket.CLOSED);
  expect((await f.send('/')).status).toBe(401);
  expect(f.connections.size).toBe(0);
});
