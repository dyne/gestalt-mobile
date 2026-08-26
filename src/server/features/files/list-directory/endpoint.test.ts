/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerListDirectory } from './endpoint.js';

describe('list workspace directory route', () => {
  it('validates relative paths, bounds, cursors, and maps stable outcomes', async () => {
    const app = fastify();
    registerListDirectory(app, {
      workspaces: { resolve: async () => ({ id: 'one', name: 'one', realPath: '/safe' }) },
      files: {
        list: async (_root, input) => ({
          kind: 'available',
          page: { directory: input.directory, entries: [] },
        }),
      },
    });
    for (const value of [
      '/x',
      '../x',
      'a/../b',
      'a//b',
      'a\\b',
      '.git/x',
      'a/.git/b',
      '%2e%2e%2fx',
    ]) {
      expect((await app.inject(`/api/workspaces/one/files?directory=${value}`)).statusCode).toBe(
        400,
      );
    }
    expect(
      (await app.inject('/api/workspaces/one/files?directory=docs&limit=501')).statusCode,
    ).toBe(400);
    expect((await app.inject('/api/workspaces/one/files?cursor=')).statusCode).toBe(400);
    expect((await app.inject('/api/workspaces/one/files?directory=docs')).json()).toEqual({
      directory: 'docs',
      entries: [],
    });
    await app.close();

    const unavailable = fastify();
    registerListDirectory(unavailable, {
      workspaces: { resolve: async () => ({ id: 'one', name: 'one', realPath: '/safe' }) },
      files: { list: async () => ({ kind: 'stale-cursor' }) },
    });
    expect((await unavailable.inject('/api/workspaces/one/files?cursor=opaque')).json()).toEqual({
      code: 'STALE_DIRECTORY_CURSOR',
    });
    await unavailable.close();
  });

  it.each([
    ['missing', 404, 'DIRECTORY_NOT_FOUND'],
    ['not-directory', 409, 'DIRECTORY_NOT_DIRECTORY'],
    ['unreadable', 403, 'DIRECTORY_UNREADABLE'],
    ['invalid-cursor', 400, 'INVALID_DIRECTORY_CURSOR'],
  ] as const)('maps %s to a sanitized problem', async (kind, status, code) => {
    const app = fastify();
    registerListDirectory(app, {
      workspaces: { resolve: async () => ({ id: 'one', name: 'one', realPath: '/safe' }) },
      files: { list: async () => ({ kind }) },
    });
    const response = await app.inject('/api/workspaces/one/files?cursor=opaque');
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ code });
    await app.close();
  });
});
