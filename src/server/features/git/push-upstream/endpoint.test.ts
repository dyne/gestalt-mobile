import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerPushUpstream } from './endpoint.js';

describe('POST /api/sessions/:id/git/push', () => {
  it('pushes only a branch that is ahead of its upstream', async () => {
    const app = fastify();
    let pushed = false;
    registerPushUpstream(app, {
      find: () => ({ workspacePath: '/workspace' }) as never,
      inspect: async () => ({
        available: true,
        branch: 'main',
        upstream: 'origin/main',
        ahead: 1,
        behind: 0,
        dirty: { staged: 0, unstaged: 0, untracked: 0 },
        commits: [],
        fetchedAt: null,
      }),
      push: async () => {
        pushed = true;
      },
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/sessions/session-1/git/push' })).statusCode,
    ).toBe(202);
    expect(pushed).toBe(true);
    await app.close();
  });

  it('does not repeat a push for an idempotent retry', async () => {
    const app = fastify();
    let pushes = 0;
    const remembered = new Map<string, { statusCode: number; body: string }>();
    registerPushUpstream(app, {
      find: () => ({ workspacePath: '/workspace' }) as never,
      inspect: async () => ({
        available: true,
        branch: 'main',
        upstream: 'origin/main',
        ahead: 1,
        behind: 0,
        dirty: { staged: 0, unstaged: 0, untracked: 0 },
        commits: [],
        fetchedAt: null,
      }),
      push: async () => {
        pushes += 1;
      },
      idempotency: {
        get: (scope, key) => remembered.get(`${scope}:${key}`) ?? null,
        put: (scope, key, statusCode, body) =>
          remembered.set(`${scope}:${key}`, { statusCode, body }),
      },
    });
    const request = {
      method: 'POST' as const,
      url: '/api/sessions/session-1/git/push',
      headers: { 'idempotency-key': 'retry-1' },
    };
    expect((await app.inject(request)).statusCode).toBe(202);
    expect((await app.inject(request)).statusCode).toBe(202);
    expect(pushes).toBe(1);
    await app.close();
  });
});
