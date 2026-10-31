/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerUploadFile } from './endpoint.js';
import type { WorkspaceFileSource } from '../application/ports.js';

describe('workspace file upload limit', () => {
  it('accepts 100 MiB at the workspace root and rejects one byte more before writing', async () => {
    const app = fastify();
    const upload = vi.fn<NonNullable<WorkspaceFileSource['upload']>>(async () => ({
      kind: 'available' as const,
      source: '',
      path: 'large.bin',
      entryKind: 'file' as const,
      conflict: 'keep-both' as const,
    }));
    registerUploadFile(app, {
      workspaces: { resolve: async () => ({ id: 'one', name: 'one', realPath: '/workspace' }) },
      files: { list: async () => ({ kind: 'missing' }), upload },
    });
    try {
      const payload = Buffer.alloc(100 * 1024 * 1024 + 1, 42);
      const input = {
        method: 'PUT' as const,
        url: '/api/workspaces/one/files/upload?directory=&filename=large.bin&conflict=keep-both',
        headers: { 'content-type': 'application/octet-stream' },
      };
      const accepted = await app.inject({ ...input, payload: payload.subarray(0, -1) });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({ path: 'large.bin' });
      expect(upload).toHaveBeenCalledWith('/workspace', {
        directory: '',
        filename: 'large.bin',
        conflict: 'keep-both',
        content: expect.any(Buffer),
      });
      const content = upload.mock.calls[0]![1].content;
      expect(content.length).toBe(100 * 1024 * 1024);
      expect(content[0]).toBe(42);
      expect(content.at(-1)).toBe(42);
      const rejected = await app.inject({ ...input, payload });
      expect(rejected.statusCode).toBe(413);
      expect(upload).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});
