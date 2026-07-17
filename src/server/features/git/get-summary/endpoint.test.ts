/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerGetGitSummary } from './endpoint.js';

describe('GET /api/sessions/:id/git', () => {
  it('returns the active workspace summary', async () => {
    const app = fastify();
    registerGetGitSummary(app, {
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
    });
    const response = await app.inject({ method: 'GET', url: '/api/sessions/session-1/git' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ branch: 'main', ahead: 1 });
    await app.close();
  });
});
