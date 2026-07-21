/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerRefreshGit } from './endpoint.js';

describe('POST /api/git/repositories/:workspaceId/refresh', () => {
  it('returns not found without refreshing an unknown workspace', async () => {
    const app = fastify();
    let refreshed = false;
    registerRefreshGit(app, {
      workspaces: { resolveGitWorkspace: async () => null },
      refresh: async () => {
        refreshed = true;
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/git/repositories/missing/refresh',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'WORKSPACE_NOT_FOUND' });
    expect(refreshed).toBe(false);
    await app.close();
  });

  it('returns accepted when the workspace fetch is scheduled', async () => {
    const app = fastify();
    let fetched = false;
    registerRefreshGit(app, {
      workspaces: {
        resolveGitWorkspace: async (id) => ({ id, path: '/workspace', isGitRepository: true }),
      },
      refresh: async () => {
        fetched = true;
      },
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/git/repositories/repo-1/refresh' })).statusCode,
    ).toBe(202);
    expect(fetched).toBe(true);
    await app.close();
  });

  it('does not repeat a refresh for an idempotent retry', async () => {
    const app = fastify();
    let fetches = 0;
    const remembered = new Map<string, { statusCode: number; body: string }>();
    registerRefreshGit(app, {
      workspaces: {
        resolveGitWorkspace: async (id) => ({ id, path: '/workspace', isGitRepository: true }),
      },
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
      url: '/api/git/repositories/repo-1/refresh',
      headers: { 'idempotency-key': 'retry-1' },
    };
    expect((await app.inject(request)).statusCode).toBe(202);
    expect((await app.inject(request)).statusCode).toBe(202);
    expect(fetches).toBe(1);
    await app.close();
  });
});
