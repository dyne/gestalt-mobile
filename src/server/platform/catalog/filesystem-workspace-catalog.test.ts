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

  it('lists only immediate readable directories contained by the relay root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
    directories.push(root);
    await mkdir(join(root, 'beta'));
    await mkdir(join(root, 'Alpha'));
    const outside = await mkdtemp(join(tmpdir(), 'gestalt-mobile-outside-'));
    directories.push(outside);
    await symlink(outside, join(root, 'escape'));

    const workspaces = await new FilesystemWorkspaceCatalog(root).list();

    expect(workspaces.map((workspace) => workspace.name)).toEqual(['/', 'Alpha', 'beta']);
    expect(workspaces.every((workspace) => !workspace.name.includes('escape'))).toBe(true);
  });
});
