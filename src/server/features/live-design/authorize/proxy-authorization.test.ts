/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { once } from 'node:events';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ClientRequest,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { previewAuthFixture, mobileOrigin, origin } from '../preview-auth.fixture.js';
import {
  PreviewProxyAuthorization,
  stripPreviewResponseHeaders,
} from '../../../platform/live-design/preview-proxy-authorization.js';
import { PreviewConnections } from '../../../platform/live-design/preview-connections.js';
import { SqlitePreviewGrantStore } from '../../../platform/live-design/sqlite-preview-grant-store.js';
import {
  ownedPreviewHttp,
  OwnedPreviewWebSockets,
  relayPreviewHttpBody,
  relayPreviewWebSockets,
} from '../../../platform/live-design/preview-stream-transports.js';
import { LiveAuthError } from '../application/grants.js';
import type { PreviewInstance } from '../application/ports.js';
import type { PreviewRequest } from './use-case.js';
import { authorizedDeviceId, webAuthnCredentialId } from '../../auth/domain/identifiers.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.useRealTimers();
});
async function authorizedFixture() {
  const f = await previewAuthFixture(cleanup, 20);
  const launched = await f.launch();
  const grant = {
    grantId: launched.json().grantId as string,
    grant: launched.json().grant as string,
  };
  const exchanged = await f.exchange(grant);
  expect(exchanged.statusCode).toBe(201);
  const cookie = String(exchanged.headers['set-cookie']).split(';')[0]!;
  const a = f.audience();
  const instance: PreviewInstance = {
    relayId: a.relayId,
    appId: a.appId,
    liveId: a.liveId,
    generation: a.generation,
    previewOrigin: a.previewOrigin,
  };
  const adapter = new PreviewProxyAuthorization(f.deps, instance, f.connections);
  const headers = {
    host: new URL(origin).host,
    cookie,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  };
  const request: PreviewRequest = { method: 'GET', target: '/', headers, websocket: false };
  return { ...f, cookie, grant, adapter, instance, request };
}
function denied(call: () => unknown, code: string, status?: number) {
  try {
    call();
    expect.fail('Expected authorization rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(LiveAuthError);
    expect((error as LiveAuthError).code).toBe(code);
    if (status) expect((error as LiveAuthError).status).toBe(status);
  }
}

describe('preview-all-paths-auth and preview-cross-origin-resource-denial', () => {
  it.each([
    '/',
    '/src/App.svelte',
    '/src/App.svelte.map',
    '/assets/app.js',
    '/assets/app.css',
    '/__gestalt_live/editor',
    '/__gestalt_live/events',
    '/hmr',
  ])('authorizes %s before any upstream connection', async (target) => {
    const f = await authorizedFixture();
    const close = vi.fn();
    const permit = f.adapter.open({ ...f.request, target }, { close });
    expect(permit.active()).toBe(true);
    permit.release();
    denied(
      () =>
        f.adapter.open(
          { ...f.request, target, headers: { ...f.request.headers, cookie: undefined } },
          { close },
        ),
      'LIVE_AUTH_REQUIRED',
      401,
    );
    expect(close).not.toHaveBeenCalled();
    expect(f.connections.size).toBe(0);
  });
  it('requires exact Origin for mutations and WS upgrades, and never trusts forwarded metadata', async () => {
    const f = await authorizedFixture();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      denied(
        () => f.adapter.open({ ...f.request, method }, { close() {} }),
        'ORIGIN_NOT_ALLOWED',
        403,
      );
      const permit = f.adapter.open(
        { ...f.request, method, headers: { ...f.request.headers, origin } },
        { close() {} },
      );
      permit.release();
    }
    denied(
      () => f.adapter.open({ ...f.request, websocket: true }, { close() {} }),
      'ORIGIN_NOT_ALLOWED',
    );
    denied(
      () =>
        f.adapter.open(
          {
            ...f.request,
            websocket: true,
            headers: { ...f.request.headers, origin: 'https://preview.example.test:9444' },
          },
          { close() {} },
        ),
      'ORIGIN_NOT_ALLOWED',
    );
    const ws = f.adapter.open(
      { ...f.request, websocket: true, headers: { ...f.request.headers, origin } },
      { close() {} },
    );
    ws.release();
    denied(
      () =>
        f.adapter.open(
          {
            ...f.request,
            headers: {
              ...f.request.headers,
              host: 'attacker.test',
              'x-forwarded-host': new URL(origin).host,
              forwarded: `host=${new URL(origin).host}`,
            },
          },
          { close() {} },
        ),
      'LIVE_ORIGIN_MISMATCH',
      421,
    );
    for (const target of [
      'https://attacker.test/',
      '//attacker.test/',
      '/%2f%2fattacker.test/',
      '/src/../__gestalt_live/',
      '/%2e%2e/',
      '/%00/',
      '/\\attacker.test/',
      '/%',
    ])
      denied(
        () => f.adapter.open({ ...f.request, target }, { close() {} }),
        'LIVE_INVALID_REQUEST',
      );
    denied(
      () =>
        f.adapter.open(
          { ...f.request, headers: { ...f.request.headers, Cookie: f.cookie } },
          { close() {} },
        ),
      'LIVE_INVALID_REQUEST',
    );
    denied(
      () =>
        f.adapter.open(
          { ...f.request, headers: { ...f.request.headers, cookie: `${f.cookie}; ${f.cookie}` } },
          { close() {} },
        ),
      'LIVE_AUTH_REQUIRED',
    );
  });
  it('checks HEAD and OPTIONS and isolates scripts/images/iframes and missing Fetch Metadata', async () => {
    const f = await authorizedFixture();
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      for (const site of ['same-site', 'cross-site', undefined])
        denied(
          () =>
            f.adapter.open(
              { ...f.request, method, headers: { ...f.request.headers, 'sec-fetch-site': site } },
              { close() {} },
            ),
          'LIVE_CROSS_ORIGIN_REQUEST',
          403,
        );
    }
    for (const dest of ['script', 'image', 'iframe'])
      denied(
        () =>
          f.adapter.open(
            {
              ...f.request,
              headers: {
                ...f.request.headers,
                'sec-fetch-site': 'same-site',
                'sec-fetch-dest': dest,
              },
            },
            { close() {} },
          ),
        'LIVE_CROSS_ORIGIN_REQUEST',
      );
    denied(
      () =>
        f.adapter.open(
          {
            ...f.request,
            headers: {
              ...f.request.headers,
              'sec-fetch-mode': 'navigate',
              'sec-fetch-dest': 'iframe',
            },
          },
          { close() {} },
        ),
      'LIVE_CROSS_ORIGIN_REQUEST',
    );
    const navigation = f.adapter.open(
      {
        ...f.request,
        headers: {
          ...f.request.headers,
          'sec-fetch-site': 'none',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        },
      },
      { close() {} },
    );
    navigation.release();
  });
  it('authorizes browser WS without Fetch Metadata only with exact bound Origin and a valid lease', async () => {
    const f = await authorizedFixture();
    const request: PreviewRequest = {
      ...f.request,
      websocket: true,
      headers: { host: new URL(origin).host, cookie: f.cookie, origin, upgrade: 'websocket' },
    };
    const permit = f.adapter.open(request, { close() {} });
    expect(permit.active()).toBe(true);
    permit.release();
    for (const foreign of [undefined, mobileOrigin, 'https://preview.example.test:9444'])
      denied(
        () =>
          f.adapter.open(
            { ...request, headers: { ...request.headers, origin: foreign } },
            { close() {} },
          ),
        'ORIGIN_NOT_ALLOWED',
        403,
      );
    for (const site of ['same-site', 'cross-site'])
      denied(
        () =>
          f.adapter.open(
            { ...request, headers: { ...request.headers, 'sec-fetch-site': site } },
            { close() {} },
          ),
        'LIVE_CROSS_ORIGIN_REQUEST',
        403,
      );
    denied(
      () =>
        f.adapter.open(
          { ...request, headers: { ...request.headers, cookie: undefined } },
          { close() {} },
        ),
      'LIVE_AUTH_REQUIRED',
      401,
    );
    denied(
      () => f.adapter.open({ ...request, websocket: false }, { close() {} }),
      'LIVE_INVALID_REQUEST',
      400,
    );
    expect(f.connections.size).toBe(0);
  });
  it('binds to immutable assigned instance metadata and rejects another port, relay, app or generation', async () => {
    const f = await authorizedFixture();
    for (const other of [
      { relayId: 'other' },
      { appId: 'other' },
      { liveId: 'other' },
      { generation: 2 },
    ]) {
      const adapter = new PreviewProxyAuthorization(
        f.deps,
        { ...f.instance, ...other },
        f.connections,
      );
      denied(() => adapter.open(f.request, { close() {} }), 'LIVE_AUTH_REQUIRED');
    }
    const otherOrigin = 'https://preview.example.test:9444';
    const adapter = new PreviewProxyAuthorization(
      f.deps,
      { ...f.instance, previewOrigin: otherOrigin },
      f.connections,
    );
    denied(
      () =>
        adapter.open(
          { ...f.request, headers: { ...f.request.headers, host: new URL(otherOrigin).host } },
          { close() {} },
        ),
      'LIVE_AUTH_REQUIRED',
    );
    denied(
      () =>
        adapter.open(
          {
            ...f.request,
            headers: {
              ...f.request.headers,
              host: new URL(otherOrigin).host,
              cookie: f.cookie.replace('p9443', 'p9444'),
            },
          },
          { close() {} },
        ),
      'LIVE_AUTH_REQUIRED',
    );
    denied(
      () =>
        new PreviewProxyAuthorization(
          f.deps,
          { ...f.instance, previewOrigin: 'https://mobile.example.test:9444' },
          f.connections,
        ),
      'LIVE_PREVIEW_HOST_CONFLICT',
    );
    denied(
      () => new PreviewProxyAuthorization(f.deps, { ...f.instance, generation: 0 }, f.connections),
      'LIVE_INVALID_REQUEST',
    );
    const original = { ...f.instance };
    const bound = new PreviewProxyAuthorization(f.deps, original, f.connections);
    original.generation = 99;
    const permit = bound.open(f.request, { close() {} });
    expect(permit.active()).toBe(true);
    permit.release();
    expect((await f.mobile.inject({ url: '/__gestalt_live/authorize' })).statusCode).toBe(404);
  });
  it('closes on auth/owner-store failure and never acts as a credential oracle', async () => {
    const f = await authorizedFixture();
    const close = vi.fn();
    const permit = f.adapter.open(f.request, { close });
    f.setAudience(null);
    expect(permit.active()).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    const unavailable = new PreviewProxyAuthorization(
      {
        ...f.deps,
        owners: {
          read() {
            throw new Error(f.cookie);
          },
        },
      },
      f.instance,
      f.connections,
    );
    denied(() => unavailable.open(f.request, { close() {} }), 'LIVE_AUTH_UNAVAILABLE', 503);
  });
});

describe('proxy-credential-stripping', () => {
  it('strips all cookies, authorization/control headers and user-selected identity before forwarding', async () => {
    const f = await authorizedFixture();
    const permit = f.adapter.open(
      {
        ...f.request,
        headers: {
          ...f.request.headers,
          cookie: `${f.cookie}; gestalt_mobile_session=${f.session}; app_cookie=private`,
          authorization: 'Bearer private',
          'proxy-authorization': 'private',
          'x-api-key': 'private',
          'x-gestalt-live-id': 'forged',
          'x-gestalt-control-token': 'private',
          'x-forwarded-host': 'mobile.example.test',
          forwarded: 'private',
          accept: 'application/javascript',
          'sec-websocket-protocol': 'vite-hmr',
        },
      },
      { close() {} },
    );
    expect(permit.upstreamHeaders).toEqual({
      accept: 'application/javascript',
      'sec-websocket-protocol': 'vite-hmr',
      'x-gestalt-live-id': 'live',
      'x-gestalt-live-generation': '1',
    });
    expect(JSON.stringify(permit.upstreamHeaders)).not.toContain(f.session);
    expect(JSON.stringify(permit.upstreamHeaders)).not.toContain(f.cookie);
    permit.release();
    const response = stripPreviewResponseHeaders({
      'set-cookie': ['evil=private'],
      'access-control-allow-origin': '*',
      'access-control-allow-credentials': 'true',
      'content-security-policy': 'frame-ancestors *',
      'cross-origin-resource-policy': 'cross-origin',
      'x-gestalt-control-token': 'private',
      'content-type': 'text/html',
    });
    expect(response['set-cookie']).toBeUndefined();
    expect(response['access-control-allow-origin']).toBeUndefined();
    expect(response['access-control-allow-credentials']).toBeUndefined();
    expect(response['content-security-policy']).toEqual([
      'frame-ancestors *',
      "frame-ancestors 'none'",
    ]);
    expect(response['cross-origin-resource-policy']).toBe('same-origin');
    expect(response['cache-control']).toBe('no-store');
    expect(JSON.stringify(response)).not.toContain('private');
  });
});

describe('revocation barriers and connection deadline', () => {
  it('denies a response when the lease expires during an authoritative owner check', async () => {
    const f = await authorizedFixture();
    const deps = {
      ...f.deps,
      owners: {
        read: () => {
          f.advance(300);
          return f.audience();
        },
      },
    };
    const adapter = new PreviewProxyAuthorization(deps, f.instance, f.connections);
    denied(() => adapter.open(f.request, { close() {} }), 'LIVE_AUTH_REQUIRED');
    expect(f.connections.size).toBe(0);
  });
  it('does not return logout 204 while an owned transport is still closing', async () => {
    const f = await authorizedFixture();
    let resolveClose!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const close = vi.fn(() => pending);
    const permit = f.adapter.open(f.request, { close });
    let finished = false;
    const logout = f.mobile
      .inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { origin: mobileOrigin, cookie: f.cookieHeader },
      })
      .then((result) => {
        finished = true;
        return result;
      });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    expect(permit.active()).toBe(false);
    expect(f.auth.sessionDevice(f.session, f.deps.now().toISOString())).toBeNull();
    resolveClose();
    expect((await logout).statusCode).toBe(204);
  });
  it('retains failed transport closure so Stop and shutdown cannot claim successful cleanup', async () => {
    const f = await authorizedFixture();
    const registry = new PreviewConnections(f.deps);
    const adapter = new PreviewProxyAuthorization(f.deps, f.instance, registry);
    const permit = adapter.open(f.request, {
      close: () => {
        throw new Error('transport close failed');
      },
    });
    await expect(registry.revoke({ liveId: 'live' })).rejects.toThrow('transport close failed');
    expect(permit.active()).toBe(false);
    await expect(registry.close()).rejects.toThrow('transport close failed');
    expect((await f.launch()).statusCode).toBe(409);
  });
  it('enforces a fixed 60s timer even when the wall clock is unchanged or moves backward', async () => {
    const f = await authorizedFixture();
    vi.useFakeTimers();
    const registry = new PreviewConnections(f.deps);
    const adapter = new PreviewProxyAuthorization(f.deps, f.instance, registry);
    const close = vi.fn();
    const permit = adapter.open(f.request, { close });
    f.advance(-10);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(permit.active()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(permit.active()).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
    await registry.close();
    vi.useRealTimers();
  });
});

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}
async function networkGateway(
  f: Awaited<ReturnType<typeof authorizedFixture>>,
  adapter = f.adapter,
) {
  const received: { target: string; headers: IncomingMessage['headers'] }[] = [];
  const intervals = new Set<ReturnType<typeof setInterval>>();
  const upstream = createServer((request, response) => {
    received.push({ target: request.url!, headers: request.headers });
    response.setHeader('Set-Cookie', 'app_session=private');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Content-Security-Policy', 'frame-ancestors *');
    if (request.url === '/sse') {
      response.setHeader('Content-Type', 'text/event-stream');
      response.write('data: connected\n\n');
      const interval = setInterval(() => response.write('data: update\n\n'), 10);
      intervals.add(interval);
      response.on('close', () => {
        clearInterval(interval);
        intervals.delete(interval);
      });
    } else response.end(`private-app:${request.url}`);
  });
  const upstreamWs = new WebSocketServer({ server: upstream });
  upstreamWs.on('connection', (socket, request) => {
    received.push({ target: request.url!, headers: request.headers });
    socket.on('message', (value, binary) => socket.send(value, { binary }));
    socket.on('error', () => {});
  });
  const upstreamPort = await listen(upstream);
  const gateway = createServer((request, response) => {
    let pending: ClientRequest | undefined;
    let body: IncomingMessage | undefined;
    try {
      const transport = ownedPreviewHttp(response, () => {
        pending?.destroy();
        body?.destroy();
      });
      const permit = adapter.open(
        {
          method: request.method!,
          target: request.url!,
          headers: request.headers,
          websocket: false,
        },
        transport,
      );
      pending = httpRequest(
        {
          hostname: '127.0.0.1',
          port: upstreamPort,
          path: request.url,
          method: request.method,
          headers: permit.upstreamHeaders,
        },
        (incoming) => {
          body = incoming;
          if (!permit.active()) {
            incoming.destroy();
            return;
          }
          response.writeHead(incoming.statusCode!, stripPreviewResponseHeaders(incoming.headers));
          relayPreviewHttpBody(permit, incoming, response);
        },
      );
      pending.on('error', () => {
        permit.release();
        response.destroy();
      });
      request.on('data', (data) => {
        if (permit.active()) pending!.write(data);
      });
      request.on('end', () => {
        if (permit.active()) pending!.end();
      });
      response.on('close', () => {
        permit.release();
        pending?.destroy();
      });
    } catch (error) {
      const failure = error as LiveAuthError;
      response.writeHead(failure.status ?? 503, {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      response.end(failure.code ?? 'LIVE_AUTH_UNAVAILABLE');
    }
  });
  const gatewayWs = new WebSocketServer({ noServer: true });
  gateway.on('upgrade', (request, socket, head) => {
    let upstreamSocket: WebSocket | undefined;
    let clientSocket: WebSocket | undefined;
    const transport = new OwnedPreviewWebSockets(() => {
      if (!clientSocket) socket.destroy();
      if (upstreamSocket?.readyState === WebSocket.CONNECTING) upstreamSocket.terminate();
    });
    try {
      const permit = adapter.open(
        {
          method: request.method!,
          target: request.url!,
          headers: request.headers,
          websocket: true,
        },
        transport,
      );
      gatewayWs.handleUpgrade(request, socket, head, (client) => {
        clientSocket = client;
        transport.bind(client);
        if (!permit.active()) return;
        const headers = { ...permit.upstreamHeaders };
        const protocols =
          headers['sec-websocket-protocol']?.split(',').map((value) => value.trim()) ?? [];
        delete headers['sec-websocket-protocol'];
        upstreamSocket = new WebSocket(`ws://127.0.0.1:${upstreamPort}${request.url}`, protocols, {
          headers,
        });
        transport.bind(upstreamSocket);
        upstreamSocket.on('error', () => client.terminate());
        client.on('error', () => {});
        upstreamSocket.once('open', () => {
          if (permit.active()) {
            relayPreviewWebSockets(permit, client, upstreamSocket!);
            client.send('ready');
          }
        });
      });
    } catch (error) {
      const failure = error as LiveAuthError;
      socket.end(
        `HTTP/1.1 ${failure.status ?? 503} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    }
  });
  const port = await listen(gateway);
  cleanup.push(async () => {
    await f.connections.close();
    for (const timer of intervals) clearInterval(timer);
    for (const ws of [...gatewayWs.clients, ...upstreamWs.clients]) ws.terminate();
    gateway.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => gateway.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
    gatewayWs.close();
    upstreamWs.close();
  });
  function http(
    path: string,
    headers: PreviewRequest['headers'] = f.request.headers,
  ): Promise<{ status: number; body: string; headers: IncomingMessage['headers'] }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path,
          headers: Object.fromEntries(
            Object.entries(headers).filter(([, value]) => value !== undefined),
          ),
        },
        (response) => {
          let body = '';
          response.on('data', (chunk) => {
            body += chunk.toString();
          });
          response.on('end', () =>
            resolve({ status: response.statusCode!, body, headers: response.headers }),
          );
          response.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end();
    });
  }
  async function sse() {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpRequest(
        { hostname: '127.0.0.1', port, path: '/sse', headers: f.request.headers },
        resolve,
      );
      req.on('error', reject);
      req.end();
    });
    let chunks = 0;
    response.on('error', () => {});
    const closed = new Promise<void>((resolve) => response.once('close', resolve));
    response.on('data', () => chunks++);
    await once(response, 'data');
    return { response, closed, chunks: () => chunks };
  }
  async function ws(headers = { ...f.request.headers, origin }) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/hmr`, ['vite-hmr'], { headers });
    socket.on('error', () => {});
    const ready = once(socket, 'message');
    await once(socket, 'open');
    await ready;
    return socket;
  }
  return { http, sse, ws, port, received, intervals };
}

describe('preview-stream-revocation on real owned HTTP/WS transports', () => {
  it('protects real app/source/assets and strips request and response credentials', async () => {
    const f = await authorizedFixture();
    const net = await networkGateway(f);
    for (const target of [
      '/',
      '/src/App.svelte',
      '/assets/app.js',
      '/src/App.svelte.map',
      '/__gestalt_live/editor',
      '/sse',
    ]) {
      const anonymous = await net.http(target, { ...f.request.headers, cookie: undefined });
      expect(anonymous.status).toBe(401);
      expect(anonymous.body).not.toContain('private-app');
      expect(net.received).toHaveLength(0);
    }
    const anonymousWs = new WebSocket(`ws://127.0.0.1:${net.port}/hmr`, ['vite-hmr'], {
      headers: { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin' },
    });
    anonymousWs.on('error', () => {});
    const rejectedUpgrade = await new Promise<number>((resolve) =>
      anonymousWs.once('unexpected-response', (_request, response) => {
        response.resume();
        anonymousWs.terminate();
        resolve(response.statusCode!);
      }),
    );
    expect(rejectedUpgrade).toBe(401);
    expect(net.received).toHaveLength(0);
    const response = await net.http('/', {
      ...f.request.headers,
      cookie: `${f.cookie}; gestalt_mobile_session=${f.session}; app=private`,
      authorization: 'Bearer private',
      'x-gestalt-control-token': 'private',
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe('private-app:/');
    expect(net.received[0]!.headers.cookie).toBeUndefined();
    expect(net.received[0]!.headers.authorization).toBeUndefined();
    expect(net.received[0]!.headers['x-gestalt-control-token']).toBeUndefined();
    expect(net.received[0]!.headers['x-gestalt-live-id']).toBe('live');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
  });
  it.each(['logout', 'device', 'Stop'] as const)(
    '%s closes a held SSE and HMR connection before completion, rejects subsequent requests, and cleans up timers',
    async (action) => {
      const f = await authorizedFixture();
      const net = await networkGateway(f);
      const sse = await net.sse();
      const ws = await net.ws();
      const echoed = once(ws, 'message');
      ws.send('before-revocation');
      expect(String((await echoed)[0])).toBe('before-revocation');
      const wsClosed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
      const started = Date.now();
      if (action === 'logout') {
        const response = await f.mobile.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: { origin: mobileOrigin, cookie: f.cookieHeader },
        });
        expect(response.statusCode).toBe(204);
      } else if (action === 'device') {
        f.auth.authorizeDevice({
          ...f.device,
          id: authorizedDeviceId('second'),
          credentialId: webAuthnCredentialId('second'),
        });
        const response = await f.mobile.inject({
          method: 'DELETE',
          url: '/api/auth/devices/device',
          headers: { origin: mobileOrigin, cookie: f.cookieHeader },
        });
        expect(response.statusCode).toBe(204);
      } else await f.connections.revoke({ liveId: 'live' });
      await sse.closed;
      expect(await wsClosed).toBe(1008);
      expect(Date.now() - started).toBeLessThan(2500);
      const chunks = sse.chunks();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(sse.chunks()).toBe(chunks);
      expect(f.connections.size).toBe(0);
      expect(net.intervals.size).toBe(0);
      expect((await net.http('/assets/app.js')).status).toBe(401);
      expect(f.store.listLeases(f.audience().authSessionHash, 'relay')).toHaveLength(0);
      if (action === 'Stop') expect((await f.launch()).statusCode).toBe(409); // Durable barrier blocks re-mint before lifecycle projection updates.
    },
  );
  it('does not revoke the final device and keeps authorized streams alive after the existing 409', async () => {
    const f = await authorizedFixture();
    const net = await networkGateway(f);
    const sse = await net.sse();
    const result = await f.mobile.inject({
      method: 'DELETE',
      url: '/api/auth/devices/device',
      headers: { origin: mobileOrigin, cookie: f.cookieHeader },
    });
    expect(result.statusCode).toBe(409);
    expect(result.json().code).toBe('LAST_DEVICE_REQUIRED');
    expect(f.connections.size).toBe(1);
    expect(sse.response.destroyed).toBe(false);
    await f.connections.close();
    await sse.closed;
  });
  it('observes another controller connection revocation and closes held streams without a new request', async () => {
    const f = await authorizedFixture();
    const secondStore = new SqlitePreviewGrantStore(f.home);
    cleanup.push(() => secondStore.close());
    const deps = { ...f.deps, store: secondStore };
    const secondRegistry = new PreviewConnections(deps);
    cleanup.push(() => secondRegistry.close());
    const adapter = new PreviewProxyAuthorization(deps, f.instance, secondRegistry);
    const net = await networkGateway(f, adapter);
    const sse = await net.sse();
    const ws = await net.ws();
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    const started = Date.now();
    await f.connections.revoke({ liveId: 'live' });
    await sse.closed;
    expect(await closed).toBe(1008);
    expect(Date.now() - started).toBeLessThan(7500);
    expect(secondRegistry.size).toBe(0);
    expect((await f.launch()).statusCode).toBe(409);
  }, 10_000);
  it.each(['owner', 'generation', 'lease', 'absolute', 'maximum stream age'])(
    'revalidates %s and closes actual held transports',
    async (reason) => {
      const f = await authorizedFixture();
      const net = await networkGateway(f);
      const sse = await net.sse();
      const ws = await net.ws();
      const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
      if (reason === 'owner') f.setAudience(null);
      if (reason === 'generation') f.setAudience({ ...f.audience(), generation: 2 });
      if (reason === 'lease') {
        const lease = f.store.listLeases(f.audience().authSessionHash, 'relay')[0]!;
        f.store.renew(lease.leaseId, (value) => ({
          ...value,
          leaseExpiresAt: f.deps.now().toISOString(),
        }));
      }
      if (reason === 'absolute') {
        const lease = f.store.listLeases(f.audience().authSessionHash, 'relay')[0]!;
        f.store.renew(lease.leaseId, (value) => ({
          ...value,
          absoluteExpiresAt: f.deps.now().toISOString(),
        }));
      }
      if (reason === 'maximum stream age') f.advance(60);
      await sse.closed;
      expect(await closed).toBe(1008);
      expect(f.connections.size).toBe(0);
    },
  );
  it('never extends an already-open stream beyond 60 seconds even after lease renewal', async () => {
    const f = await authorizedFixture();
    const net = await networkGateway(f);
    const sse = await net.sse();
    const lease = f.store.listLeases(f.audience().authSessionHash, 'relay')[0]!;
    f.store.renew(lease.leaseId, (value) => ({
      ...value,
      leaseExpiresAt: '2026-10-10T12:10:00.000Z',
    }));
    f.advance(60);
    await sse.closed;
    expect(f.connections.size).toBe(0);
  });
  it('terminates a late WebSocket binding after its ownership was revoked', async () => {
    const f = await authorizedFixture();
    const net = await networkGateway(f);
    const socket = await net.ws();
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    const stale = new OwnedPreviewWebSockets(() => {});
    await stale.close();
    stale.bind(socket);
    expect(await closed).toBe(1006);
    await vi.waitFor(() => expect(f.connections.size).toBe(0));
  });
});
