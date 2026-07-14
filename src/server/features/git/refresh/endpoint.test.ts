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
});
