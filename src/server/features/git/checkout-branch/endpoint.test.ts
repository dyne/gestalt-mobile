/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerCheckoutBranch } from './endpoint.js';

describe('POST /api/git/repositories/:workspaceId/checkout', () => {
  it('checks out a selected local branch for the resolved repository', async () => {
    const app = fastify();
    const checkout = vi.fn(async () => undefined);
    registerCheckoutBranch(app, {
      workspaces: {
        resolveGitWorkspace: async (id) => ({ id, path: '/workspace', isGitRepository: true }),
      },
      checkout,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/git/repositories/repo-1/checkout',
      payload: { branch: 'topic' },
    });
    expect(response.statusCode).toBe(202);
    expect(checkout).toHaveBeenCalledWith('/workspace', 'topic');
    await app.close();
  });
});
