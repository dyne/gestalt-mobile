/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemWorkspaceFiles } from '../../../platform/filesystem/filesystem-workspace-files.js';
import { registerCreateDirectory } from './endpoint.js';

describe('create workspace directory', () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-create-folder-'));
    const app = fastify();
    cleanups.push(
      () => rm(root, { recursive: true, force: true }),
      () => app.close(),
    );
    registerCreateDirectory(app, {
      workspaces: {
        resolve: async (id) => {
          if (id !== 'one') throw new Error('WORKSPACE_NOT_FOUND');
          return { id, name: id, realPath: root };
        },
      },
      files: new FilesystemWorkspaceFiles(),
    });
    const create = (payload: Record<string, unknown>, workspace = 'one') =>
      app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspace}/files/directories`,
        payload,
      });
    return { app, root, create };
  }

  it('creates a folder at the root and inside an existing folder', async () => {
    const { root, create } = await setup();
    for (const directory of ['', 'Documents']) {
      const name = directory ? 'Project notes 文' : 'Documents';
      const response = await create({ directory, name });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        path: directory ? `${directory}/${name}` : name,
        entryKind: 'directory',
      });
      expect((await lstat(join(root, directory, name))).isDirectory()).toBe(true);
    }
  });

  it('rejects invalid names and traversal without writing outside the selected parent', async () => {
    const { create } = await setup();
    for (const name of [
      '',
      ' ',
      '.',
      '..',
      '.git',
      '../outside',
      '/absolute',
      'a/b',
      'a\\b',
      'a\0b',
    ]) {
      expect((await create({ directory: '', name })).statusCode).toBe(400);
    }
    for (const directory of ['../outside', '/absolute', '.git']) {
      expect((await create({ directory, name: 'safe' })).statusCode).toBe(400);
    }
    expect((await create({ name: 'missing-parent-field' })).statusCode).toBe(400);
  });

  it('preserves existing files and folders and maps missing workspaces', async () => {
    const { root, create } = await setup();
    await writeFile(join(root, 'exists'), 'keep me');
    await mkdir(join(root, 'folder'));
    for (const name of ['exists', 'folder']) {
      const response = await create({ directory: '', name });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ code: 'FILE_CONFLICT', replaceAllowed: false });
    }
    expect(await readFile(join(root, 'exists'), 'utf8')).toBe('keep me');
    expect((await create({ directory: '', name: 'safe' }, 'missing')).statusCode).toBe(404);
  });
});
