import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerReleaseSession } from './endpoint.js';

describe('POST /api/sessions/:id/release', () => {
  it('persists release before closing relay ownership', async () => {
    const app = fastify();
    const calls: string[] = [];
    registerReleaseSession(app, {
      find: () => ({ id: 'session-1' }) as never,
      release: () => ({ id: 'session-1', state: 'released' }) as never,
      save: () => calls.push('save'),
      close: () => calls.push('close'),
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/sessions/session-1/release' })).statusCode,
    ).toBe(202);
    expect(calls).toEqual(['save', 'close']);
    await app.close();
  });

  it('replays a release response without closing the runtime twice', async () => {
    const app = fastify();
    const responses = new Map<string, string>();
    let closed = 0;
    registerReleaseSession(app, {
      find: () => ({ id: 'session-1' }) as never,
      release: () => ({ id: 'session-1', state: 'released' }) as never,
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
      url: '/api/sessions/session-1/release',
      headers: { 'idempotency-key': 'release-retry' },
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect([first.statusCode, second.statusCode]).toEqual([202, 202]);
    expect(closed).toBe(1);
    await app.close();
  });
});
