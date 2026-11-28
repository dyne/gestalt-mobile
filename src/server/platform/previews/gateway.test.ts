/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { previewHandoffPath } from '../../../shared/contracts/preview.js';
import { buildApp } from '../../app.js';
import { PreviewService } from '../../features/previews/application/service.js';
import { createPreviewGateway } from './gateway.js';

const relayOrigin = 'https://relay.example';
const previewOrigin = 'https://preview.example';
const relayCookie = 'gestalt_mobile_session=live';
const headers = { origin: relayOrigin, cookie: relayCookie };
const route = '/api/sessions/session-1/preview';

async function listen(server: Server) {
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  return (server.address() as AddressInfo).port;
}

describe('passkey-protected preview', () => {
  let now: number;
  let validLogin: boolean;
  let active: Set<string>;
  let relay: Awaited<ReturnType<typeof buildApp>>;
  let gateway: ReturnType<typeof createPreviewGateway>;
  let gatewayPort: number;
  let upstream: Server;
  let sockets: WebSocketServer;
  let upstreamRequests: number;

  beforeEach(async () => {
    now = Date.parse('2026-10-02T00:00:00.000Z');
    validLogin = true;
    active = new Set(['session-1', 'session-2']);
    upstreamRequests = 0;
    const sessionDevice = (id: string) =>
      validLogin && id === 'live' ? ('device' as never) : null;
    const service = new PreviewService({
      sessionActive: (id) => active.has(id),
      loginValid: (id) => sessionDevice(id) !== null,
      now: () => now,
      token: () => randomBytes(32).toString('base64url'),
    });
    relay = await buildApp({
      auth: {
        repository: { sessionDevice } as never,
        clock: { now: () => new Date(now) },
        random: {} as never,
        identifiers: {} as never,
        webauthn: {} as never,
        relyingParty: {
          publicOrigin: relayOrigin,
          rpId: 'relay.example',
          rpName: 'Gestalt Mobile',
        },
      },
      preview: { service, origin: previewOrigin },
      logger: console,
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: null, protocolVersion: null, compatible: true },
          providers: { codex: { available: true }, kimi: { available: false } },
        }),
      },
    });
    upstream = createServer(async (req, res) => {
      upstreamRequests += 1;
      let body = '';
      for await (const chunk of req) body += String(chunk);
      res.setHeader('set-cookie', [
        'app=kept; Path=/',
        'wide=removed; Domain=example',
        '__Host-gestalt-preview=removed; Secure; Path=/',
      ]);
      res.setHeader('content-security-policy', "script-src 'self'");
      res.end(
        JSON.stringify({
          path: req.url,
          host: req.headers.host,
          forwardedHost: req.headers['x-forwarded-host'],
          forwardedProto: req.headers['x-forwarded-proto'],
          cookie: req.headers.cookie,
          body,
        }),
      );
    });
    sockets = new WebSocketServer({ server: upstream });
    sockets.on('connection', (peer) => {
      peer.on('message', (data) => peer.send(data.toString()));
    });
    gateway = createPreviewGateway(
      { origin: previewOrigin, port: 0, targetPort: await listen(upstream) },
      service,
    );
    gatewayPort = await gateway.start();
  });

  afterEach(async () => {
    await gateway?.close();
    await relay?.close();
    for (const socket of sockets?.clients ?? []) socket.terminate();
    sockets?.close();
    if (upstream?.listening) {
      const closed = once(upstream, 'close');
      upstream.close();
      await closed;
    }
  });

  function gatewayRequest(
    path: string,
    options: { method?: string; headers?: IncomingHttpHeaders; body?: string } = {},
  ) {
    return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port: gatewayPort,
            path,
            method: options.method,
            headers: { host: 'preview.example', ...options.headers },
          },
          async (res) => {
            let body = '';
            for await (const chunk of res) body += String(chunk);
            resolve({ status: res.statusCode!, headers: res.headers, body });
          },
        );
        req.once('error', reject);
        req.end(options.body);
      },
    );
  }

  function exchange(code: string, origin = previewOrigin) {
    return gatewayRequest(previewHandoffPath, { method: 'POST', headers: { origin }, body: code });
  }

  async function open() {
    const response = await relay.inject({ method: 'POST', url: route, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const url = new URL(response.json().url);
    expect(url.origin).toBe(previewOrigin);
    expect(url.pathname).toBe(previewHandoffPath);
    expect(url.search).toBe('');
    return url.hash.slice(1);
  }

  async function viewerCookie() {
    const exchangeResponse = await exchange(await open());
    expect(exchangeResponse.status).toBe(204);
    const cookie = exchangeResponse.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/^__Host-gestalt-preview=/);
    expect(cookie).toContain('Secure; HttpOnly; SameSite=Strict');
    return cookie.split(';', 1)[0];
  }

  it('requires a live Mobile login and its exact origin to issue an authorization', async () => {
    expect(
      (await relay.inject({ method: 'POST', url: route, headers: { origin: relayOrigin } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await relay.inject({
          method: 'POST',
          url: route,
          headers: { ...headers, origin: previewOrigin },
        })
      ).statusCode,
    ).toBe(403);
    expect((await gatewayRequest('/', { headers: { cookie: relayCookie } })).status).toBe(401);
    expect(upstreamRequests).toBe(0);
  });

  it('exchanges a one-use fragment grant and forwards app requests without relay credentials', async () => {
    const cookie = await viewerCookie();
    const other = await open();
    expect((await exchange(other, relayOrigin)).status).toBe(403);
    expect((await exchange(other)).status).toBe(204);
    expect((await exchange(other)).status).toBe(401);
    expect((await exchange(other.repeat(2))).status).toBe(400);
    const response = await gatewayRequest('/api/save?q=1', {
      method: 'POST',
      headers: {
        origin: previewOrigin,
        cookie: `${cookie}; ${relayCookie}; app=kept`,
        'x-forwarded-host': 'spoofed.example',
      },
      body: 'example body',
    });
    expect(response.status).toBe(200);
    expect(response.headers['set-cookie']).toEqual(['app=kept; Path=/']);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(JSON.parse(response.body)).toEqual({
      path: '/api/save?q=1',
      host: 'preview.example',
      forwardedHost: 'preview.example',
      forwardedProto: 'https',
      cookie: 'app=kept',
      body: 'example body',
    });
    expect(
      (await gatewayRequest('/sw.js', { headers: { cookie, 'service-worker': 'script' } })).status,
    ).toBe(403);
    expect(
      (await gatewayRequest('/', { method: 'POST', headers: { cookie, origin: relayOrigin } }))
        .status,
    ).toBe(403);
    expect((await gatewayRequest('/', { headers: { cookie, host: 'wrong.example' } })).status).toBe(
      421,
    );
    expect(upstreamRequests).toBe(1);
  });

  it('forwards authenticated WebSockets and disconnects them when the session stops the preview', async () => {
    const cookie = await viewerCookie();
    const socketUrl = `ws://127.0.0.1:${gatewayPort}/hmr`;
    const rejected = new WebSocket(socketUrl, {
      headers: { host: 'preview.example', origin: relayOrigin, cookie },
    });
    await expect(once(rejected, 'open')).rejects.toThrow('401');
    const socket = new WebSocket(socketUrl, {
      headers: { host: 'preview.example', origin: previewOrigin, cookie },
    });
    await once(socket, 'open');
    const echo = once(socket, 'message');
    socket.send('reload');
    expect(String((await echo)[0])).toBe('reload');
    const busy = await relay.inject({
      method: 'POST',
      url: '/api/sessions/session-2/preview',
      headers,
    });
    expect(busy.statusCode).toBe(409);
    const otherStop = await relay.inject({
      method: 'DELETE',
      url: '/api/sessions/session-2/preview',
      headers,
    });
    expect(otherStop.statusCode).toBe(409);
    const closed = once(socket, 'close');
    expect((await relay.inject({ method: 'DELETE', url: route, headers })).statusCode).toBe(204);
    await closed;
    expect((await gatewayRequest('/', { headers: { cookie } })).status).toBe(401);
    expect(
      (await relay.inject({ method: 'POST', url: '/api/sessions/session-2/preview', headers }))
        .statusCode,
    ).toBe(200);
  });

  it('rejects expired grants, logged-out viewers, and stopped sessions', async () => {
    const code = await open();
    now += 31_000;
    expect((await exchange(code)).status).toBe(401);
    const cookie = await viewerCookie();
    validLogin = false;
    expect((await gatewayRequest('/', { headers: { cookie } })).status).toBe(401);
    validLogin = true;
    const next = await viewerCookie();
    active.delete('session-1');
    expect((await gatewayRequest('/', { headers: { cookie: next } })).status).toBe(401);
    expect((await relay.inject({ method: 'POST', url: route, headers })).statusCode).toBe(404);
  });
});
