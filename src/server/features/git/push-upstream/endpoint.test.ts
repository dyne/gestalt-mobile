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
});
