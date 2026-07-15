import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerRefreshGit } from './endpoint.js';

describe('POST /api/sessions/:id/git/refresh', () => {
  it('returns accepted when the workspace fetch is scheduled', async () => {
    const app = fastify();
    let fetched = false;
    registerRefreshGit(app, {
      find: () => ({ workspacePath: '/workspace' }) as never,
      refresh: async () => {
        fetched = true;
      },
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/sessions/session-1/git/refresh' })).statusCode,
    ).toBe(202);
    expect(fetched).toBe(true);
    await app.close();
  });

  it('does not repeat a refresh for an idempotent retry', async () => {
    const app = fastify();
    let fetches = 0;
    const remembered = new Map<string, { statusCode: number; body: string }>();
    registerRefreshGit(app, {
      find: () => ({ workspacePath: '/workspace' }) as never,
      refresh: async () => {
        fetches += 1;
      },
      idempotency: {
        get: (scope, key) => remembered.get(`${scope}:${key}`) ?? null,
        put: (scope, key, statusCode, body) =>
          remembered.set(`${scope}:${key}`, { statusCode, body }),
      },
    });
    const request = {
      method: 'POST' as const,
      url: '/api/sessions/session-1/git/refresh',
      headers: { 'idempotency-key': 'retry-1' },
    };
    expect((await app.inject(request)).statusCode).toBe(202);
    expect((await app.inject(request)).statusCode).toBe(202);
    expect(fetches).toBe(1);
    await app.close();
  });
});
