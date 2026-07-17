/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { buildApp, type AppDependencies } from '../../../app.js';

describe('GET /api/sessions/recent-threads', () => {
  it('returns recent Codex sessions, including sessions not managed by the relay', async () => {
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
      recentThreads: {
        list: async () => [
          { id: 'thread-new', cwd: '/projects/new', recencyAt: 200 },
          { id: 'thread-old', cwd: '/projects/old', recencyAt: 100 },
        ],
      },
    } as AppDependencies);

    const response = await app.inject({ method: 'GET', url: '/api/sessions/recent-threads' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { id: 'thread-new', cwd: '/projects/new', recencyAt: 200 },
      { id: 'thread-old', cwd: '/projects/old', recencyAt: 100 },
    ]);
    await app.close();
  });
});
