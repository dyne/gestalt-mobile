/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerSelectModel } from './endpoint.js';

describe('POST /api/sessions/:id/model', () => {
  it('persists an available model for an idle session', async () => {
    const app = fastify();
    let saved: unknown;
    registerSelectModel(app, {
      find: () => ({
        id: 's',
        workspaceId: 'workspace',
        workspacePath: '/workspace',
        profile: 'default',
        model: 'old',
        threadId: 'thread',
        state: 'ready',
        desiredState: 'active',
        activeTurnId: null,
        protocolVersion: null,
        failureCount: 0,
        pendingInteractions: [],
        createdAt: 'before',
        updatedAt: 'before',
      }),
      models: async () => ['gpt-5.6-terra'],
      now: () => 'after',
      save: (session) => (saved = session),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/s/model',
      payload: { model: 'gpt-5.6-terra' },
    });
    expect(response.statusCode).toBe(200);
    expect(saved).toMatchObject({ model: 'gpt-5.6-terra', updatedAt: 'after' });
    await app.close();
  });
});
