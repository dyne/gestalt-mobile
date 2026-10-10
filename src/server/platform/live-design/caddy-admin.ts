/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { request } from 'node:http';
import { isAbsolute } from 'node:path';

export type CaddyReply = { status: number; etag?: string; body: unknown };

/** Controller-only IO. Not an HTTP route, agent tool, or generic broker operation. */
export class UnixCaddyAdmin {
  constructor(readonly socketPath: string) {
    if (!isAbsolute(socketPath) || socketPath.includes('\0'))
      throw new Error('Caddy admin requires an absolute Unix socket path');
  }
  async request(
    method: 'GET' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    etag?: string,
    body?: unknown,
  ): Promise<CaddyReply> {
    // Even a compromised route caller cannot use this adapter for /load or global replacement.
    if (
      (method === 'GET' && path !== '/config/apps/http/servers') ||
      (method !== 'GET' &&
        !/^\/config\/apps\/http\/servers\/gestalt_live_[a-f0-9]{32}$/.test(path)) ||
      (method !== 'GET' && !etag)
    )
      throw new Error('LIVE_CADDY_OPERATION_REJECTED');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          agent: false,
          method,
          path,
          headers: {
            ...(etag ? { 'if-match': etag } : {}),
            ...(payload ? { 'content-type': 'application/json' } : {}),
          },
        },
        (response) => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            data += chunk;
            if (Buffer.byteLength(data) > 2 * 1024 * 1024)
              req.destroy(new Error('LIVE_CADDY_RESPONSE_LIMIT'));
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              resolve({
                status: response.statusCode ?? 503,
                etag: response.headers.etag,
                body: data ? JSON.parse(data) : null,
              });
            } catch {
              reject(new Error('LIVE_CADDY_INVALID_RESPONSE'));
            }
          });
        },
      );
      const deadline = setTimeout(() => req.destroy(new Error('LIVE_CADDY_TIMEOUT')), 5000);
      req.once('close', () => clearTimeout(deadline));
      req.once('error', reject);
      req.end(payload);
    });
  }
}
