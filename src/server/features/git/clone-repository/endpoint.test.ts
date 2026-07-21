/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerCloneRepository } from './endpoint.js';

describe('POST /api/git/clone', () => {
  it('resolves an ordinary workspace before cloning a supplied Git address', async () => {
    const app = fastify();
    let clone: { path: string; address: string } | null = null;
    registerCloneRepository(app, {
      workspaces: {
        resolveGitWorkspace: async (id) => ({
          id,
          path: '/bounded/workspace',
          isGitRepository: false,
        }),
      },
      clone: async (path, address) => void (clone = { path, address }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/git/clone',
      payload: { workspaceId: 'workspace-1', address: 'https://example.test/gestalt.git' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
    expect(clone).toEqual({
      path: '/bounded/workspace',
      address: 'https://example.test/gestalt.git',
    });
    await app.close();
  });

  it('rejects an empty Git address', async () => {
    const app = fastify();
    let called = false;
    registerCloneRepository(app, {
      workspaces: { resolveGitWorkspace: async () => null },
      clone: async () => void (called = true),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/git/clone',
      payload: { workspaceId: 'workspace-1' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'INVALID_CLONE_ADDRESS' });
    expect(called).toBe(false);
    await app.close();
  });

  it.each([
    {
      label: 'unknown workspace',
      workspace: null,
      statusCode: 404,
      code: 'WORKSPACE_NOT_FOUND',
    },
    {
      label: 'repository workspace',
      workspace: { id: 'repository', path: '/bounded/repository', isGitRepository: true },
      statusCode: 409,
      code: 'WORKSPACE_IS_GIT_REPOSITORY',
    },
  ])('rejects an $label before invoking Git', async ({ workspace, statusCode, code }) => {
    const app = fastify();
    let called = false;
    registerCloneRepository(app, {
      workspaces: { resolveGitWorkspace: async () => workspace },
      clone: async () => void (called = true),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/git/clone',
      payload: { workspaceId: 'catalog-id', address: 'https://example.test/gestalt.git' },
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({ code });
    expect(called).toBe(false);
    await app.close();
  });
});
