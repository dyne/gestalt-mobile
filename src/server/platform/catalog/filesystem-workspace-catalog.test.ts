/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FilesystemWorkspaceCatalog } from './filesystem-workspace-catalog.js';

describe('FilesystemWorkspaceCatalog', () => {
  const directories: string[] = [];
  afterEach(async () =>
    Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))),
  );

  it('returns a selectable rooted tree with opaque resolvable node IDs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
    directories.push(root);
    await mkdir(join(root, 'beta'));
    await mkdir(join(root, 'Alpha'));
    const outside = await mkdtemp(join(tmpdir(), 'gestalt-mobile-outside-'));
    directories.push(outside);
    await symlink(outside, join(root, 'escape'));

    const catalog = new FilesystemWorkspaceCatalog(root);
    const workspaces = await catalog.list();

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      name: '/',
      relativePath: '.',
      isGitRepository: false,
    });
    expect(workspaces[0]?.children.map((workspace) => workspace.name)).toEqual(['Alpha', 'beta']);
    expect(workspaces[0]?.children.every((workspace) => !workspace.name.includes('escape'))).toBe(
      true,
    );

    const rootNode = workspaces[0];
    const alpha = rootNode?.children[0];
    expect(rootNode && (await catalog.resolve(rootNode.id))).toEqual({
      id: rootNode?.id,
      name: '/',
      realPath: root,
    });
    expect(alpha && (await catalog.resolve(alpha.id))).toEqual({
      id: alpha?.id,
      name: 'Alpha',
      realPath: join(root, 'Alpha'),
    });
  });
});
