/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerPullRebase } from './endpoint.js';

describe('POST /api/sessions/:id/git/pull', () => {
  it('exposes a pull --rebase failure', async () => {
    const app = fastify();
    registerPullRebase(app, {
      find: () => ({ workspacePath: '/workspace' }) as never,
      pull: async () => {
        throw new Error('cannot pull with rebase: You have unstaged changes.');
      },
    });
    const response = await app.inject({ method: 'POST', url: '/api/sessions/s/git/pull' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'GIT_PULL_FAILED',
      detail: 'cannot pull with rebase: You have unstaged changes.',
    });
    await app.close();
  });
});
