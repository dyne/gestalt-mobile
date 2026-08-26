/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { lstat, mkdtemp, mkdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseRelativeDirectory } from '../../features/files/domain/relative-directory.js';
import { FilesystemWorkspaceFiles } from './filesystem-workspace-files.js';

const directory = (value: string) => parseRelativeDirectory(value)!;

describe('FilesystemWorkspaceFiles', () => {
  it('returns bounded deterministic pages and leaves symlinks disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-files-'));
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'alpha'), 'a');
    await writeFile(join(root, '.dot'), 'd');
    await writeFile(join(root, '文'), 'u');
    await mkdir(join(root, '.git'));
    await symlink(join(root, 'nested'), join(root, 'internal-link'));
    await symlink(tmpdir(), join(root, 'escaping-link'));
    const files = new FilesystemWorkspaceFiles();
    const first = await files.list(root, { directory: directory(''), limit: 2 });
    expect(first).toMatchObject({
      kind: 'available',
      page: {
        entries: [
          { name: 'nested', kind: 'directory' },
          { name: '.dot', kind: 'file' },
        ],
      },
    });
    if (first.kind !== 'available') throw new Error('page unavailable');
    const second = await files.list(root, {
      directory: directory(''),
      limit: 20,
      cursor: first.page.nextCursor,
    });
    expect(second).toMatchObject({ kind: 'available' });
    if (second.kind !== 'available') throw new Error('page unavailable');
    expect([...first.page.entries, ...second.page.entries].map((entry) => entry.name)).toEqual([
      'nested',
      '.dot',
      'alpha',
      '文',
      'escaping-link',
      'internal-link',
    ]);
    expect(second.page.entries.find((entry) => entry.name === 'escaping-link')).toEqual({
      name: 'escaping-link',
      path: 'escaping-link',
      kind: 'symlink',
    });
    expect(await files.list(root, { directory: directory('internal-link'), limit: 1 })).toEqual({
      kind: 'missing',
    });
  });

  it('rejects malformed and stale cursors without exposing a filesystem path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-files-'));
    await writeFile(join(root, 'one'), '1');
    await writeFile(join(root, 'two'), '2');
    const files = new FilesystemWorkspaceFiles();
    expect(
      await files.list(root, { directory: directory(''), limit: 1, cursor: 'not-a-cursor' }),
    ).toEqual({ kind: 'invalid-cursor' });
    const page = await files.list(root, { directory: directory(''), limit: 1 });
    if (page.kind !== 'available' || !page.page.nextCursor) throw new Error('missing cursor');
    await writeFile(join(root, 'three'), '3');
    expect(
      await files.list(root, { directory: directory(''), limit: 1, cursor: page.page.nextCursor }),
    ).toEqual({ kind: 'stale-cursor' });
  });

  it('uses Unicode code-point order rather than UTF-16 code-unit order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-files-'));
    await writeFile(join(root, '\uE000'), 'bmp');
    await writeFile(join(root, '\u{10000}'), 'astral');
    const page = await new FilesystemWorkspaceFiles().list(root, {
      directory: directory(''),
      limit: 10,
    });
    expect(page).toMatchObject({ kind: 'available' });
    if (page.kind !== 'available') throw new Error('page unavailable');
    expect(page.page.entries.map((entry) => entry.name)).toEqual(['\uE000', '\u{10000}']);
  });

  it('returns sanitized missing, non-directory, unreadable, and disappearing outcomes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-files-'));
    await writeFile(join(root, 'regular'), 'file');
    await writeFile(join(root, '.git'), 'protected');
    const files = new FilesystemWorkspaceFiles();
    expect(await files.list(root, { directory: directory('missing'), limit: 1 })).toEqual({
      kind: 'missing',
    });
    expect(await files.list(root, { directory: directory('regular'), limit: 1 })).toEqual({
      kind: 'not-directory',
    });
    const rootPage = await files.list(root, { directory: directory(''), limit: 10 });
    expect(rootPage).toMatchObject({ kind: 'available' });
    if (rootPage.kind !== 'available') throw new Error('page unavailable');
    expect(rootPage.page.entries.map((entry) => entry.name)).not.toContain('.git');
    const disappearing = new FilesystemWorkspaceFiles({
      lstat: async (path) => {
        if (String(path).endsWith('/gone')) {
          const error = Object.assign(new Error('gone'), { code: 'ENOENT' });
          throw error;
        }
        return lstat(path);
      },
      readdir: async () => ['gone'],
      realpath,
      stat,
    });
    expect(await disappearing.list(root, { directory: directory(''), limit: 1 })).toEqual({
      kind: 'available',
      page: { directory: '', entries: [] },
    });
    const unreadable = new FilesystemWorkspaceFiles({
      lstat,
      readdir: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
      realpath,
      stat,
    });
    expect(await unreadable.list(root, { directory: directory(''), limit: 1 })).toEqual({
      kind: 'unreadable',
    });
  });
});
