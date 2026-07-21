/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerGetGitSummary } from './endpoint.js';

describe('GET /api/git/repositories/:workspaceId', () => {
  it('resolves an opaque repository ID before inspecting Git', async () => {
    const app = fastify();
    let inspectedPath = '';
    registerGetGitSummary(app, {
      workspaces: {
        resolveGitWorkspace: async (id) => ({
          id,
          path: '/bounded/repository',
          isGitRepository: true,
        }),
      },
      inspect: async (path) => {
        inspectedPath = path;
        return {
          available: true,
          branch: 'main',
          upstream: 'origin/main',
          ahead: 1,
          behind: 0,
          dirty: { staged: 0, unstaged: 0, untracked: 0 },
          commits: [],
          fetchedAt: null,
        };
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/git/repositories/opaque-repository-id',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ branch: 'main', ahead: 1 });
    expect(inspectedPath).toBe('/bounded/repository');
    await app.close();
  });

  it.each([
    {
      label: 'unknown ID',
      workspace: null,
      statusCode: 404,
      code: 'WORKSPACE_NOT_FOUND',
    },
    {
      label: 'ordinary folder',
      workspace: { id: 'ordinary', path: '/bounded/ordinary', isGitRepository: false },
      statusCode: 409,
      code: 'WORKSPACE_NOT_GIT_REPOSITORY',
    },
  ])('rejects an $label without inspecting Git', async ({ workspace, statusCode, code }) => {
    const app = fastify();
    let inspected = false;
    registerGetGitSummary(app, {
      workspaces: { resolveGitWorkspace: async () => workspace },
      inspect: async () => {
        inspected = true;
        throw new Error('should not inspect');
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/git/repositories/catalog-id',
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({ code });
    expect(inspected).toBe(false);
    await app.close();
  });
});
