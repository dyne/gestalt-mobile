/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerStopSession } from './endpoint.js';

describe('POST /api/sessions/:id/stop', () => {
  it('persists a stopped session and closes its app-server process', async () => {
    const app = fastify();
    let closed = false;
    registerStopSession(app, {
      find: () => ({ id: 'session-1', state: 'ready' }) as never,
      stop: (session) => ({ ...session, state: 'stopped' }) as never,
      save: () => {},
      close: () => {
        closed = true;
      },
    });
    const response = await app.inject({ method: 'POST', url: '/api/sessions/session-1/stop' });
    expect(response.statusCode).toBe(202);
    expect(closed).toBe(true);
    await app.close();
  });

  it('replays a stop response without closing the runtime twice', async () => {
    const app = fastify();
    const responses = new Map<string, string>();
    let closed = 0;
    registerStopSession(app, {
      find: () => ({ id: 'session-1', state: 'ready' }) as never,
      stop: (session) => ({ ...session, state: 'stopped' }) as never,
      save: () => {},
      close: () => {
        closed += 1;
      },
      idempotency: {
        get: (_scope, key) =>
          responses.has(key) ? { statusCode: 202, body: responses.get(key)! } : null,
        put: (_scope, key, _statusCode, body) => responses.set(key, body),
      },
    });
    const request = {
      method: 'POST' as const,
      url: '/api/sessions/session-1/stop',
      headers: { 'idempotency-key': 'stop-retry' },
    };

    await app.inject(request);
    await app.inject(request);

    expect(closed).toBe(1);
    await app.close();
  });
});
