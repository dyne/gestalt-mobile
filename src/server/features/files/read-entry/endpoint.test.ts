/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerReadEntry } from './endpoint.js';

describe('file preview route', () => {
  it('validates requests and returns a read-only preview', async () => {
    const app = fastify();
    registerReadEntry(app, {
      workspaces: { resolve: async () => ({ id: 'one', name: 'one', realPath: '/safe' }) },
      files: {
        list: async () => ({ kind: 'missing' }),
        read: async (_root, path) => ({
          kind: 'available',
          preview: { kind: 'file', path, content: 'hello', size: 5 },
        }),
      },
    });
    for (const query of ['', '?path=a&path=b', '?path=%00', `?path=${'a'.repeat(4097)}`]) {
      expect((await app.inject(`/api/workspaces/one/files/preview${query}`)).statusCode).toBe(400);
    }
    expect(
      (await app.inject('/api/workspaces/one/files/preview?path=docs%2Fhello.txt')).json(),
    ).toEqual({ kind: 'file', path: 'docs/hello.txt', content: 'hello', size: 5 });
    await app.close();
  });
  it.each([
    ['missing', 404],
    ['unreadable', 403],
    ['unsupported', 415],
    ['too-large', 413],
  ] as const)('maps %s without exposing paths', async (kind, status) => {
    const app = fastify();
    registerReadEntry(app, {
      workspaces: { resolve: async () => ({ id: 'one', name: 'one', realPath: '/safe' }) },
      files: { list: async () => ({ kind: 'missing' }), read: async () => ({ kind }) },
    });
    expect((await app.inject('/api/workspaces/one/files/preview?path=hello')).statusCode).toBe(
      status,
    );
    await app.close();
  });
});
