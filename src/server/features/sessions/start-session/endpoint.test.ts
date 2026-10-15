/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerStartSession } from './endpoint.js';

it.each([
  ['LIVE_PROJECT_METADATA_PRESENT', 503],
  ['LIVE_CLEANUP_REQUIRED', 503],
  ['LIVE_SESSION_BUSY', 409],
] as const)('returns a bounded %s problem after failed owning startup', async (code, status) => {
  const app = Fastify();
  const save = vi.fn(),
    releaseStartup = vi.fn(async () => {});
  registerStartSession(app, {
    createId: () => 'owner',
    now: () => 'time',
    save,
    releaseStartup,
    workspaces: {
      resolve: async () => ({ id: 'workspace', name: 'workspace', realPath: '/workspace' }),
    },
    profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
    skillProfiles: {
      readGlobalProfile: async () => undefined,
      readWorkspaceDefault: async () => undefined,
    },
    skillCatalog: () => ({
      list: async () => {
        throw new Error('AUXILIARY_FORBIDDEN');
      },
    }),
    owningStartup: {
      supports: () => true,
      start: async () => {
        throw Object.assign(new Error('/private/SHOULD_NOT_EXPOSE'), { code });
      },
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workspaceId: 'workspace', profile: 'default', provider: 'codex' },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code, status });
    expect(response.body).not.toContain('SHOULD_NOT_EXPOSE');
    expect(save).not.toHaveBeenCalled();
    expect(releaseStartup).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});
