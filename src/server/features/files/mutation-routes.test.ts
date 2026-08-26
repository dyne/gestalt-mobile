/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerCopyEntry } from './copy-entry/endpoint.js';
import { registerDeleteEntry } from './delete-entry/endpoint.js';
import { registerMoveEntry } from './move-entry/endpoint.js';
import { registerUploadFile } from './upload-file/endpoint.js';

const dependencies = {
  workspaces: { resolve: async () => ({ id: 'one', name: 'one', realPath: '/safe' }) },
  files: {
    list: async () => ({ kind: 'missing' as const }),
    copy: async () => ({
      kind: 'available' as const,
      source: 'a',
      path: 'b/a',
      entryKind: 'file' as const,
      conflict: 'reject' as const,
    }),
    move: async () => ({ kind: 'conflict' as const, replaceAllowed: true }),
    upload: async () => ({
      kind: 'available' as const,
      source: '',
      path: 'file',
      entryKind: 'file' as const,
      conflict: 'reject' as const,
    }),
    delete: async () => ({ kind: 'protected' as const }),
  },
};
describe('workspace file mutation routes', () => {
  it('validates and maps copy, move, upload, and delete without raw errors', async () => {
    const app = fastify();
    registerCopyEntry(app, dependencies);
    registerMoveEntry(app, dependencies);
    registerUploadFile(app, dependencies);
    registerDeleteEntry(app, dependencies);
    expect(
      (await app.inject({ method: 'POST', url: '/api/workspaces/one/files/copy', payload: {} }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/workspaces/one/files/copy',
          payload: { source: 'a', destinationDirectory: 'b', conflict: 'reject' },
        })
      ).json(),
    ).toMatchObject({ path: 'b/a' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/workspaces/one/files/move',
          payload: { source: 'a', destinationDirectory: 'b', conflict: 'reject' },
        })
      ).json(),
    ).toEqual({ code: 'FILE_CONFLICT', replaceAllowed: true });
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/workspaces/one/files/upload?directory=&filename=x&conflict=reject',
          headers: { 'content-type': 'application/octet-stream' },
          payload: Buffer.from([0, 255]),
        })
      ).json(),
    ).toMatchObject({ path: 'file' });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/workspaces/one/files',
          payload: { path: '.git', recursive: true },
        })
      ).json(),
    ).toEqual({ code: 'FILE_PROTECTED' });
    await app.close();
  });
});
