/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  request,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream';

export const previewCookie = '__Host-gestalt-preview';

const hopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

function endToEndHeaders(original: IncomingHttpHeaders): IncomingHttpHeaders {
  const headers = { ...original };
  const nominated = original.connection?.split(',').map((name) => name.trim().toLowerCase()) ?? [];
  for (const name of [...hopHeaders, ...nominated]) delete headers[name];
  return headers;
}

export function cookieName(part: string): string {
  return part.split('=', 1)[0].trim();
}

function requestHeaders(browser: IncomingMessage, origin: URL): IncomingHttpHeaders {
  const headers = endToEndHeaders(browser.headers);
  for (const name of Object.keys(headers)) {
    if (name === 'forwarded' || name.startsWith('x-forwarded-')) delete headers[name];
  }
  const appCookies = headers.cookie
    ?.split(';')
    .filter((part) => ![previewCookie, 'gestalt_mobile_session'].includes(cookieName(part)));
  if (appCookies?.length) headers.cookie = appCookies.join(';').trim();
  else delete headers.cookie;
  headers.host = origin.host;
  headers['x-forwarded-host'] = origin.host;
  headers['x-forwarded-proto'] = 'https';
  return headers;
}

function responseHeaders(upstream: IncomingHttpHeaders): IncomingHttpHeaders {
  const headers = endToEndHeaders(upstream);
  const cookies = headers['set-cookie']?.filter((cookie) => {
    const [value, ...attributes] = cookie.split(';');
    return (
      ![previewCookie, 'gestalt_mobile_session'].includes(cookieName(value)) &&
      !attributes.some((attribute) => cookieName(attribute).toLowerCase() === 'domain')
    );
  });
  if (cookies?.length) headers['set-cookie'] = cookies;
  else delete headers['set-cookie'];
  headers['cache-control'] = 'no-store';
  headers['referrer-policy'] = 'no-referrer';
  headers['x-frame-options'] = 'DENY';
  const policy = headers['content-security-policy'];
  headers['content-security-policy'] = [
    ...(typeof policy === 'string' ? [policy] : (policy ?? [])),
    "frame-ancestors 'none'",
  ];
  return headers;
}

export function unavailable(response: ServerResponse): void {
  response
    .writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    .end('The preview server is unavailable. Start the configured dev server and retry.');
}

export function rejectUpgrade(socket: Duplex, status: '401 Unauthorized' | '502 Bad Gateway') {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function upstreamRequest(
  browser: IncomingMessage,
  headers: IncomingHttpHeaders,
  port: number,
): ClientRequest {
  const upstream = request({
    hostname: '127.0.0.1',
    port,
    method: browser.method,
    path: browser.url,
    headers,
  });
  upstream.setTimeout(10_000, () => upstream.destroy(new Error('Preview upstream timed out')));
  return upstream;
}

type Track = (disconnect: () => void) => () => void;

export function proxyHttp(
  browser: IncomingMessage,
  response: ServerResponse,
  target: { port: number; origin: URL },
  track: Track,
): void {
  const upstream = upstreamRequest(browser, requestHeaders(browser, target.origin), target.port);
  const untrack = track(() => {
    upstream.destroy();
    response.destroy();
  });
  response.once('close', () => {
    untrack();
    if (!response.writableFinished) upstream.destroy();
  });
  upstream.once('error', () => {
    browser.unpipe(upstream);
    browser.resume();
    if (!response.headersSent && !response.destroyed) unavailable(response);
    else response.destroy();
  });
  upstream.once('response', (incoming) => {
    upstream.setTimeout(0);
    response.writeHead(incoming.statusCode ?? 502, responseHeaders(incoming.headers));
    pipeline(incoming, response, () => {});
  });
  browser.pipe(upstream);
}

export function proxyWebSocket(
  browser: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: { port: number; origin: URL },
  track: Track,
): void {
  const headers = requestHeaders(browser, target.origin);
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';
  const upstream = upstreamRequest(browser, headers, target.port);
  let peer: Duplex | undefined;
  const untrack = track(() => socket.destroy());
  socket.once('error', () => socket.destroy());
  socket.once('close', () => {
    untrack();
    upstream.destroy();
    peer?.destroy();
  });
  upstream.once('error', () => {
    if (!peer && !socket.destroyed) rejectUpgrade(socket, '502 Bad Gateway');
  });
  upstream.once('response', (response) => {
    response.destroy();
    if (!socket.destroyed) rejectUpgrade(socket, '502 Bad Gateway');
  });
  upstream.once('upgrade', (response, connected, initial) => {
    if (socket.destroyed) {
      connected.destroy();
      return;
    }
    connected.setTimeout(0);
    peer = connected;
    connected.once('error', () => socket.destroy());
    connected.once('close', () => socket.destroy());
    const handshake = responseHeaders(response.headers);
    handshake.connection = 'Upgrade';
    handshake.upgrade = 'websocket';
    let reply = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (const [name, values] of Object.entries(handshake)) {
      for (const value of typeof values === 'string' ? [values] : (values ?? []))
        reply += `${name}: ${value}\r\n`;
    }
    socket.write(`${reply}\r\n`);
    if (initial.length) socket.write(initial);
    if (head.length) connected.write(head);
    socket.pipe(connected).pipe(socket);
  });
  upstream.end();
}
