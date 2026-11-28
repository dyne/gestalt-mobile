/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform, pipeline } from 'node:stream';

export const impeccablePath = '/.impeccable-live';
const bootstrapPath = `${impeccablePath}/bootstrap.js`;
const liveAssets = new Set(['/live.js', '/detect.js', '/modern-screenshot.js']);
const reads = new Set([
  ...liveAssets,
  '/events',
  '/status',
  '/source',
  '/design-system.json',
  '/design-system/raw',
  '/manual-edit-stash',
]);
const writes = new Set([
  '/events',
  '/annotation',
  '/manual-edit-stash',
  '/manual-edit-commit',
  '/manual-edit-discard',
  '/manual-edit-repair-decision',
]);

export type ImpeccableHelper = { root: string; marker: string; port: number; token: string };
type Track = (disconnect: () => void) => () => void;
const maxJsonBytes = 2 * 1024 * 1024;
const maxAnnotationBytes = 8 * 1024 * 1024;

function within(root: string, path: string): boolean {
  const tail = relative(root, path);
  return !isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`);
}

async function boundedBody(stream: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('Impeccable request exceeded its size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function helperStream(response: Response): Readable {
  return response.body
    ? Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
    : Readable.from([]);
}

function helperUrl(helper: ImpeccableHelper, path: string, search = ''): URL {
  const url = new URL(path, `http://127.0.0.1:${helper.port}`);
  url.search = search;
  url.searchParams.set('token', helper.token);
  return url;
}

export async function findImpeccableHelper(
  workspace: string,
): Promise<ImpeccableHelper | undefined> {
  try {
    const root = await realpath(workspace);
    const path = await realpath(join(root, '.impeccable', 'live', 'server.json'));
    if (!within(root, path)) return;
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    let marker: { token?: unknown; port?: unknown; pid?: unknown };
    try {
      if (!(await file.stat()).isFile()) return;
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await file.read(buffer);
      if (bytesRead > 4096) return;
      marker = JSON.parse(buffer.subarray(0, bytesRead).toString());
    } finally {
      await file.close();
    }
    if (
      typeof marker.port !== 'number' ||
      !Number.isSafeInteger(marker.port) ||
      marker.port < 1024 ||
      marker.port > 65535 ||
      typeof marker.pid !== 'number' ||
      !Number.isSafeInteger(marker.pid) ||
      marker.pid <= 0 ||
      typeof marker.token !== 'string' ||
      !/^[a-zA-Z0-9_-]{24,128}$/.test(marker.token)
    )
      return;
    process.kill(marker.pid, 0);
    const helper = { root, marker: path, port: marker.port, token: marker.token };
    const response = await fetch(helperUrl(helper, '/status'), {
      redirect: 'error',
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return;
    }
    const status = JSON.parse((await boundedBody(helperStream(response), maxJsonBytes)).toString());
    if (status?.port === helper.port && typeof status.agentPolling === 'boolean') return helper;
  } catch {
    // The helper may still be starting or its previous process may have exited.
  }
}

export function injectImpeccableBootstrap(): Transform {
  let head: Buffer<ArrayBufferLike> | undefined = Buffer.alloc(0);
  let injected = false;
  const script = Buffer.from(`<script src="${bootstrapPath}" defer></script>`);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (!head) return callback(null, chunk);
      head = Buffer.concat([head, chunk]);
      const index = head.toString('latin1').toLowerCase().indexOf('</head>');
      if (index >= 0 || head.length >= 64 * 1024) {
        injected = index >= 0;
        const body = injected
          ? Buffer.concat([head.subarray(0, index), script, head.subarray(index)])
          : head;
        head = undefined;
        callback(null, body);
      } else callback();
    },
    flush(callback) {
      callback(null, injected ? undefined : head ? Buffer.concat([head, script]) : script);
    },
  });
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response
    .writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'cross-origin-resource-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
    })
    .end(body);
}

const bootstrap = `(() => {
  async function connect() {
    try {
      const result = await fetch('${impeccablePath}/ready', { cache: 'no-store' });
      if (result.status === 401 || result.status === 403) return;
      if (result.status === 204) {
        const script = document.createElement('script');
        script.src = '${impeccablePath}/live.js';
        script.onerror = () => { script.remove(); setTimeout(connect, 1500); };
        document.head.appendChild(script);
        return;
      }
    } catch {}
    setTimeout(connect, 1500);
  }
  connect();
})();`;

export function browserScript(script: string, token: string): string {
  return script
    .replaceAll(token, createHash('sha256').update(token).digest('base64url'))
    .replace(
      /(['"])http:\/\/localhost:\1\s*\+\s*PORT\s*\+\s*(['"])(?=\/)/g,
      (_match, _first, quote: string) => `${quote}${impeccablePath}`,
    )
    .replaceAll('http://localhost:${PORT}', impeccablePath);
}

export async function serveImpeccable(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  findHelper: () => Promise<ImpeccableHelper | undefined>,
  track: Track,
): Promise<void> {
  const path = url.pathname.slice(impeccablePath.length);
  if (path === '/bootstrap.js' && request.method === 'GET') {
    send(response, 200, 'text/javascript; charset=utf-8', bootstrap);
    return;
  }
  const reading = request.method === 'GET' && (reads.has(path) || path === '/ready');
  const writing = request.method === 'POST' && writes.has(path);
  if (!reading && !writing) {
    send(response, 404, 'text/plain', 'Unknown Impeccable route.');
    return;
  }

  const controller = new AbortController();
  const untrack = track(() => {
    controller.abort();
    response.destroy();
  });
  response.once('close', () => {
    untrack();
    controller.abort();
  });
  try {
    const helper = await findHelper();
    if (controller.signal.aborted) return;
    if (path === '/ready') {
      send(response, helper ? 204 : 200, 'text/plain', '');
      return;
    }
    if (!helper) {
      send(response, 503, 'text/plain', 'Waiting for the Impeccable Live helper.');
      return;
    }
    if (path === '/source') {
      const name = url.searchParams.get('path');
      const source = name && (await realpath(resolve(helper.root, name)).catch(() => undefined));
      if (!source || source === helper.marker || !within(helper.root, source)) {
        send(response, 404, 'text/plain', 'Impeccable source is unavailable.');
        return;
      }
      url.searchParams.set('path', source);
    }
    let body: string | Uint8Array<ArrayBuffer> | undefined;
    let contentType = 'application/json';
    if (writing) {
      const annotation = path === '/annotation';
      const stream = request.iterator({ destroyOnReturn: false });
      let bytes: Buffer;
      try {
        bytes = await boundedBody(stream, annotation ? maxAnnotationBytes : maxJsonBytes);
      } catch {
        request.resume();
        send(response, 413, 'text/plain', 'Impeccable request body is too large.');
        return;
      }
      if (annotation) {
        body = new Uint8Array(bytes);
        contentType = 'image/png';
      } else if (
        bytes.length ||
        (path !== '/manual-edit-commit' && path !== '/manual-edit-discard')
      ) {
        let payload: unknown;
        try {
          payload = JSON.parse(bytes.toString());
        } catch {
          // The Live browser endpoints send a JSON object.
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          send(response, 400, 'text/plain', 'Impeccable request body is invalid.');
          return;
        }
        body = JSON.stringify({ ...payload, token: helper.token });
      }
    }

    const timeout = setTimeout(() => controller.abort(), 10_000);
    const upstream = await fetch(helperUrl(helper, path, url.search), {
      method: request.method,
      ...(body === undefined ? {} : { body, headers: { 'content-type': contentType } }),
      signal: controller.signal,
      redirect: 'error',
    }).finally(() => clearTimeout(timeout));
    if (path === '/live.js' && upstream.ok) {
      const script = (await boundedBody(helperStream(upstream), maxJsonBytes)).toString();
      send(response, 200, 'text/javascript; charset=utf-8', browserScript(script, helper.token));
      return;
    }
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'cross-origin-resource-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
    });
    response.flushHeaders();
    pipeline(helperStream(upstream), response, () => {});
  } catch {
    if (!response.headersSent && !response.destroyed)
      send(response, 502, 'text/plain', 'The Impeccable Live helper is unavailable.');
    else response.destroy();
  }
}
