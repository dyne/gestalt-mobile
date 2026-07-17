/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerPushUpstream } from './endpoint.js';

describe('POST /api/sessions/:id/git/push', () => {
  it('returns not found without inspecting Git for an unknown session', async () => {
    const app = fastify();
    let inspected = false;
    registerPushUpstream(app, {
      find: () => null,
      inspect: async () => {
        inspected = true;
        throw new Error('should not inspect');
      },
      push: async () => undefined,
    });

    const response = await app.inject({ method: 'POST', url: '/api/sessions/missing/git/push' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'SESSION_NOT_FOUND' });
    expect(inspected).toBe(false);
    await app.close();
  });

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
