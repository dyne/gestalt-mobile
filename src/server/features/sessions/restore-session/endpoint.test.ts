import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerRestoreSession } from './endpoint.js';

describe('POST /api/sessions/:id/restore', () => {
  it('restores a resumable session and persists its ready state', async () => {
    const app = fastify();
    let saved = false;
    registerRestoreSession(app, {
      find: () => ({ id: 'session-1', threadId: 'thread-1', state: 'stopped' }) as never,
      restore: async () => ({ id: 'session-1', state: 'ready' }) as never,
      save: () => {
        saved = true;
      },
    });
    const response = await app.inject({ method: 'POST', url: '/api/sessions/session-1/restore' });
    expect(response.statusCode).toBe(200);
    expect(saved).toBe(true);
    await app.close();
  });

  it('rejects restore when the relay already owns the thread', async () => {
    const app = fastify();
    let restored = false;
    registerRestoreSession(app, {
      find: () => ({ id: 'session-1', threadId: 'thread-1', state: 'ready' }) as never,
      restore: async () => {
        restored = true;
        return {} as never;
      },
      save: () => {},
    });

    const response = await app.inject({ method: 'POST', url: '/api/sessions/session-1/restore' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: 'SESSION_CANNOT_RESTORE' });
    expect(restored).toBe(false);
    await app.close();
  });

  it('replays a restore response without launching another runtime', async () => {
    const app = fastify();
    const responses = new Map<string, string>();
    let restores = 0;
    registerRestoreSession(app, {
      find: () => ({ id: 'session-1', threadId: 'thread-1', state: 'stopped' }) as never,
      restore: async () => {
        restores += 1;
        return { id: 'session-1', state: 'ready' } as never;
      },
      save: () => {},
      idempotency: {
        get: (_scope, key) =>
          responses.has(key) ? { statusCode: 200, body: responses.get(key)! } : null,
        put: (_scope, key, _statusCode, body) => responses.set(key, body),
      },
    });
    const request = {
      method: 'POST' as const,
      url: '/api/sessions/session-1/restore',
      headers: { 'idempotency-key': 'restore-retry' },
    };

    await app.inject(request);
    await app.inject(request);

    expect(restores).toBe(1);
    await app.close();
  });
});
