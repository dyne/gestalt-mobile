/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FilesystemWorkspaceCatalog } from './filesystem-workspace-catalog.js';

describe('FilesystemWorkspaceCatalog', () => {
  const directories: string[] = [];
  afterEach(async () =>
    Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))),
  );

  it('discovers a deterministic bounded tree and stops at repositories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
    directories.push(root);
    await mkdir(join(root, 'beta'));
    await mkdir(join(root, 'Alpha', 'deep'), { recursive: true });
    await mkdir(join(root, 'devel', 'dyne', 'gestalt', '.git'), { recursive: true });
    await mkdir(join(root, 'devel', 'dyne', 'gestalt', 'not-traversed'));
    await mkdir(join(root, '.hidden', 'secret'), { recursive: true });
    await mkdir(join(root, 'visible', '.hidden'), { recursive: true });
    await writeFile(join(root, 'ordinary-file'), 'not a directory');

    const shared = join(root, 'shared');
    await mkdir(join(shared, 'inside'), { recursive: true });
    await symlink(shared, join(root, 'alias'));
    await symlink(root, join(shared, 'cycle'));

    const unreadable = join(root, 'no-access');
    await mkdir(join(unreadable, 'private'), { recursive: true });
    await chmod(unreadable, 0o000);

    const outside = await mkdtemp(join(tmpdir(), 'gestalt-mobile-outside-'));
    directories.push(outside);
    await symlink(outside, join(root, 'escape'));
    await symlink(join(root, 'vanished-target'), join(root, 'vanished'));

    const catalog = new FilesystemWorkspaceCatalog(root);
    const workspaces = await catalog.list().finally(() => chmod(unreadable, 0o700));

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      name: '/',
      relativePath: '.',
      isGitRepository: false,
    });
    expect(workspaces[0]?.children.map((workspace) => workspace.name)).toEqual([
      'alias',
      'Alpha',
      'beta',
      'devel',
      'visible',
    ]);

    const alias = workspaces[0]?.children[0];
    expect(alias).toMatchObject({
      relativePath: 'alias',
      children: [{ name: 'inside', relativePath: 'alias/inside' }],
    });
    const devel = workspaces[0]?.children[3];
    const repository = devel?.children[0]?.children[0];
    expect(repository).toMatchObject({
      name: 'gestalt',
      relativePath: 'devel/dyne/gestalt',
      isGitRepository: true,
      children: [],
    });
    expect(workspaces[0]?.children[4]).toMatchObject({ name: 'visible', children: [] });

    const rootNode = workspaces[0];
    expect(rootNode && (await catalog.resolve(rootNode.id))).toEqual({
      id: rootNode?.id,
      name: '/',
      realPath: root,
    });
    expect(alias && (await catalog.resolve(alias.id))).toEqual({
      id: alias?.id,
      name: 'alias',
      realPath: shared,
    });
    expect(repository && (await catalog.resolve(repository.id))).toEqual({
      id: repository?.id,
      name: 'gestalt',
      realPath: join(root, 'devel', 'dyne', 'gestalt'),
    });
    await expect(catalog.resolveGitWorkspace(repository!.id)).resolves.toEqual({
      id: repository!.id,
      path: join(root, 'devel', 'dyne', 'gestalt'),
      isGitRepository: true,
    });
    await expect(catalog.resolveGitWorkspace(alias!.id)).resolves.toEqual({
      id: alias!.id,
      path: shared,
      isGitRepository: false,
    });
    const nodes = rootNode ? [rootNode] : [];
    for (let index = 0; index < nodes.length; index += 1) {
      nodes.push(...(nodes[index]?.children ?? []));
    }
    const resolvedNodes = await Promise.all(nodes.map((node) => catalog.resolve(node.id)));
    expect(resolvedNodes.map(({ id, name }) => ({ id, name }))).toEqual(
      nodes.map(({ id, name }) => ({ id, name })),
    );
    expect(rootNode?.id).not.toContain(root);
    expect(alias?.id).not.toContain(shared);
  });

  it('treats a repository root as a selectable terminal node', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-repository-root-'));
    directories.push(root);
    await mkdir(join(root, '.git'));
    await mkdir(join(root, 'not-traversed'));

    const [rootNode] = await new FilesystemWorkspaceCatalog(root).list();

    expect(rootNode).toMatchObject({
      name: '/',
      relativePath: '.',
      isGitRepository: true,
      children: [],
    });
  });

  it('rejects an unknown opaque workspace ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
    directories.push(root);

    await expect(new FilesystemWorkspaceCatalog(root).resolve('unknown')).rejects.toThrow(
      'WORKSPACE_NOT_FOUND',
    );
    await expect(new FilesystemWorkspaceCatalog(root).resolveGitWorkspace('unknown')).resolves.toBe(
      null,
    );
  });
});
