/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerArchiveWorkspacePlan } from './endpoint.js';

describe('Archive workspace plan endpoint', () => {
  it('resolves the workspace and preserves the decoded root-relative plan path', async () => {
    const app = fastify();
    const archive = vi.fn(async () => ({ kind: 'archived' as const }));
    registerArchiveWorkspacePlan(app, {
      workspaces: { resolve: async () => ({ id: 'root', name: '/', realPath: '/workspace' }) },
      archiver: { archive },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspaces/root/plans/project%2F.gestalt%2Fspace%20name.org/archive',
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ archived: true });
    expect(archive).toHaveBeenCalledWith('/workspace', 'project/.gestalt/space name.org');
    await app.close();
  });
  it.each([
    ['missing', 404],
    ['unavailable', 422],
    ['conflict', 409],
  ] as const)('maps %s to %i', async (kind, status) => {
    const app = fastify();
    registerArchiveWorkspacePlan(app, {
      workspaces: { resolve: async () => ({ id: 'root', name: '/', realPath: '/workspace' }) },
      archiver: { archive: async () => ({ kind }) },
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/workspaces/root/plans/.gestalt%2Fplan.org/archive',
        })
      ).statusCode,
    ).toBe(status);
    await app.close();
  });
  it('does not invoke archiving for an unknown workspace', async () => {
    const app = fastify();
    const archive = vi.fn(async () => ({ kind: 'archived' as const }));
    registerArchiveWorkspacePlan(app, {
      workspaces: {
        resolve: async () => {
          throw new Error('WORKSPACE_NOT_FOUND');
        },
      },
      archiver: { archive },
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/workspaces/unknown/plans/.gestalt%2Fplan.org/archive',
        })
      ).statusCode,
    ).toBe(404);
    expect(archive).not.toHaveBeenCalled();
    await app.close();
  });
});
