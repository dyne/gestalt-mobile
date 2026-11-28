/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { previewHandoffPath } from '../../../shared/contracts/preview.js';
import { buildApp } from '../../app.js';
import { PreviewService } from '../../features/previews/application/service.js';
import { createPreviewGateway } from './gateway.js';
import { findImpeccableHelper, impeccablePath } from './impeccable.js';

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
  let impeccableWorkspace: string | undefined;

  beforeEach(async () => {
    now = Date.parse('2026-10-02T00:00:00.000Z');
    validLogin = true;
    active = new Set(['session-1', 'session-2']);
    upstreamRequests = 0;
    impeccableWorkspace = undefined;
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
      preview: {
        service,
        origin: async () => previewOrigin,
        impeccableAvailable: (id) => id === 'session-1',
      },
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
      if (req.url === '/app') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-length': 26 });
        res.end('<html><head></head></html>');
        return;
      }
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
      {
        origin: previewOrigin,
        port: 0,
        targetPort: await listen(upstream),
        impeccableHelper: async () =>
          impeccableWorkspace ? findImpeccableHelper(impeccableWorkspace) : undefined,
      },
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

  async function open(impeccable = false) {
    const response = await relay.inject({
      method: 'POST',
      url: route,
      headers,
      ...(impeccable ? { payload: { impeccable: true } } : {}),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const url = new URL(response.json().url);
    expect(url.origin).toBe(previewOrigin);
    expect(url.pathname).toBe(previewHandoffPath);
    expect(url.search).toBe('');
    return url.hash.slice(1);
  }

  async function viewerCookie(impeccable = false) {
    const exchangeResponse = await exchange(await open(impeccable));
    expect(exchangeResponse.status).toBe(204);
    const cookie = exchangeResponse.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/^__Host-gestalt-preview=/);
    expect(cookie).toContain('Secure; HttpOnly; SameSite=Strict');
    return cookie.split(';', 1)[0];
  }

  it('keeps Impeccable browser requests behind an explicit edit grant and revokes the event stream', async () => {
    const ordinary = await viewerCookie();
    const editor = await viewerCookie(true);
    const browser = { cookie: editor, accept: 'text/html', origin: previewOrigin };
    expect((await gatewayRequest(`${impeccablePath}/bootstrap.js`)).status).toBe(401);
    expect(
      (await gatewayRequest(`${impeccablePath}/live.js`, { headers: { cookie: ordinary } })).status,
    ).toBe(403);
    expect((await gatewayRequest('/app', { headers: { ...browser, cookie: ordinary } })).body).toBe(
      '<html><head></head></html>',
    );
    expect((await gatewayRequest('/app', { headers: browser })).body).toContain(
      `${impeccablePath}/bootstrap.js`,
    );
    expect((await gatewayRequest(`${impeccablePath}/ready`, { headers: browser })).status).toBe(
      200,
    );
    expect(
      (
        await relay.inject({
          method: 'POST',
          url: '/api/sessions/session-2/preview',
          headers,
          payload: { impeccable: true },
        })
      ).statusCode,
    ).toBe(403);

    const token = randomBytes(32).toString('base64url');
    let forwarded: unknown;
    const helper = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.searchParams.get('token') !== token) return res.writeHead(401).end();
      if (url.pathname === '/status')
        return res.end(
          JSON.stringify({ port: (helper.address() as AddressInfo).port, agentPolling: true }),
        );
      if (url.pathname === '/live.js') {
        return res.end(
          `var TOKEN = "${token}"; fetch('http://localhost:' + PORT + '/events?token=' + TOKEN);`,
        );
      }
      if (url.pathname === '/events' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += String(chunk);
        forwarded = JSON.parse(body);
        return res.writeHead(204).end();
      }
      if (url.pathname === '/manual-edit-commit' && req.method === 'POST') {
        return res.writeHead(url.searchParams.get('pageUrl') === '/app' ? 204 : 400).end();
      }
      if (url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"connected":true}\n\n');
        return;
      }
      res.writeHead(404).end();
    });
    const workspace = await mkdtemp(join(tmpdir(), 'mobile-impeccable-'));
    try {
      const state = join(workspace, '.impeccable', 'live');
      await mkdir(state, { recursive: true });
      await writeFile(
        join(state, 'server.json'),
        JSON.stringify({
          port: await listen(helper),
          pid: process.pid,
          token,
        }),
      );
      impeccableWorkspace = workspace;
      expect((await gatewayRequest(`${impeccablePath}/ready`, { headers: browser })).status).toBe(
        204,
      );
      const script = await gatewayRequest(`${impeccablePath}/live.js`, { headers: browser });
      expect(script.body).toContain(`${impeccablePath}/events`);
      expect(script.body).not.toContain(token);
      expect((await gatewayRequest(`${impeccablePath}/poll`, { headers: browser })).status).toBe(
        404,
      );
      expect(
        (
          await gatewayRequest(`${impeccablePath}/source?path=.impeccable/live/server.json`, {
            headers: browser,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await gatewayRequest(`${impeccablePath}/events?token=browser-token`, {
            method: 'POST',
            headers: browser,
            body: '{"type":"generate","token":"browser-token"}',
          })
        ).status,
      ).toBe(204);
      expect(forwarded).toMatchObject({ type: 'generate', token });
      expect(
        (
          await gatewayRequest(`${impeccablePath}/manual-edit-commit?pageUrl=%2Fapp`, {
            method: 'POST',
            headers: browser,
          })
        ).status,
      ).toBe(204);

      const stream = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port: gatewayPort,
            path: `${impeccablePath}/events`,
            headers: { host: 'preview.example', ...browser },
          },
          resolve,
        );
        req.once('error', reject);
        req.end();
      });
      const closed = new Promise<void>((resolve) => stream.once('close', resolve));
      expect(String((await once(stream, 'data'))[0])).toContain('"connected":true');
      stream.on('error', () => {});
      expect((await relay.inject({ method: 'DELETE', url: route, headers })).statusCode).toBe(204);
      await closed;
      expect((await gatewayRequest(`${impeccablePath}/status`, { headers: browser })).status).toBe(
        401,
      );
    } finally {
      helper.closeAllConnections();
      await new Promise<void>((resolve) => helper.close(() => resolve()));
      await rm(workspace, { recursive: true, force: true });
    }
  });

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
