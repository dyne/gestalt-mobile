/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { WorkspaceFileSource } from '../../features/files/application/ports.js';
import type {
  ListWorkspaceDirectory,
  WorkspaceDirectoryPage,
  WorkspaceDirectoryResult,
  WorkspaceFileEntry,
} from '../../features/files/domain/workspace-directory.js';

type Filesystem = Readonly<{
  lstat(path: string): Promise<Stats>;
  readdir(path: string, options: { encoding: 'utf8' }): Promise<string[]>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<Stats>;
}>;
type Cursor = Readonly<{ d: string; i: number; m: number; a: string; s: string }>;

/** Lists exactly one directory; symlinks are represented but never followed. */
export class FilesystemWorkspaceFiles implements WorkspaceFileSource {
  private readonly cursors = new Map<string, Cursor>();

  constructor(private readonly filesystem: Filesystem = { lstat, readdir, realpath, stat }) {}

  async list(
    workspaceRoot: string,
    input: ListWorkspaceDirectory,
  ): Promise<WorkspaceDirectoryResult> {
    const root = await this.canonicalDirectory(workspaceRoot);
    if (!root) return { kind: 'unreadable' };
    const target = await this.targetDirectory(root, input.directory);
    if (target.kind !== 'directory') return target;
    const cursor = input.cursor === undefined ? undefined : this.cursors.get(input.cursor);
    if (input.cursor !== undefined && !cursor) return { kind: 'invalid-cursor' };
    if (
      cursor &&
      (cursor.d !== input.directory ||
        cursor.i !== Number(target.metadata.ino) ||
        cursor.m !== Number(target.metadata.mtimeMs))
    )
      return { kind: 'stale-cursor' };
    try {
      const names = await this.filesystem.readdir(target.path, { encoding: 'utf8' });
      const entries: WorkspaceFileEntry[] = [];
      for (const name of names) {
        if (name === '.git') continue;
        const child = join(target.path, name);
        try {
          const metadata = await this.filesystem.lstat(child);
          const kind = metadata.isSymbolicLink()
            ? 'symlink'
            : metadata.isDirectory()
              ? 'directory'
              : metadata.isFile()
                ? 'file'
                : null;
          if (!kind) continue;
          const path = input.directory === '' ? name : `${input.directory}/${name}`;
          entries.push({
            name,
            path,
            kind,
            ...(kind === 'file'
              ? { size: metadata.size, modifiedAt: metadata.mtime.toISOString() }
              : {}),
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'unreadable' };
        }
      }
      entries.sort(compareEntries);
      if (cursor && cursor.s !== snapshot(entries)) return { kind: 'stale-cursor' };
      const start = cursor ? entries.findIndex((entry) => entry.name === cursor.a) + 1 : 0;
      if (cursor && start === 0) return { kind: 'stale-cursor' };
      const pageEntries = entries.slice(start, start + input.limit);
      const last = pageEntries.at(-1);
      const nextCursor =
        start + pageEntries.length < entries.length && last
          ? this.rememberCursor({
              d: input.directory,
              i: Number(target.metadata.ino),
              m: Number(target.metadata.mtimeMs),
              a: last.name,
              s: snapshot(entries),
            })
          : undefined;
      const page: WorkspaceDirectoryPage = {
        directory: input.directory,
        entries: pageEntries,
        ...(nextCursor ? { nextCursor } : {}),
      };
      return { kind: 'available', page };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { kind: 'missing' }
        : { kind: 'unreadable' };
    }
  }

  private rememberCursor(cursor: Cursor): string {
    const token = randomUUID();
    this.cursors.set(token, cursor);
    if (this.cursors.size > 2_000) this.cursors.delete(this.cursors.keys().next().value!);
    return token;
  }

  private async canonicalDirectory(path: string): Promise<string | null> {
    if (!isAbsolute(path)) return null;
    try {
      const canonical = await this.filesystem.realpath(resolve(path));
      return (await this.filesystem.stat(canonical)).isDirectory() ? canonical : null;
    } catch {
      return null;
    }
  }

  private async targetDirectory(
    root: string,
    directory: string,
  ): Promise<
    | { kind: 'directory'; path: string; metadata: Stats }
    | Exclude<WorkspaceDirectoryResult, { kind: 'available' }>
  > {
    let path = root;
    for (const segment of directory === '' ? [] : directory.split('/')) {
      path = join(path, segment);
      try {
        const metadata = await this.filesystem.lstat(path);
        if (metadata.isSymbolicLink()) return { kind: 'missing' };
        const canonical = await this.filesystem.realpath(path);
        if (!within(root, canonical)) return { kind: 'missing' };
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? { kind: 'missing' }
          : { kind: 'unreadable' };
      }
    }
    try {
      const metadata = await this.filesystem.lstat(path);
      if (metadata.isSymbolicLink()) return { kind: 'missing' };
      if (!metadata.isDirectory()) return { kind: 'not-directory' };
      const canonical = await this.filesystem.realpath(path);
      if (!within(root, canonical) || !(await this.filesystem.stat(canonical)).isDirectory())
        return { kind: 'missing' };
      return { kind: 'directory', path: canonical, metadata };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { kind: 'missing' }
        : { kind: 'unreadable' };
    }
  }
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}
function compareEntries(left: WorkspaceFileEntry, right: WorkspaceFileEntry): number {
  const rank = { directory: 0, file: 1, symlink: 2 } as const;
  return rank[left.kind] - rank[right.kind] || compareCodePoints(left.name, right.name);
}
/** Unicode scalar-value ordering, independent of host locale and UTF-16 code units. */
function compareCodePoints(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex)!;
    const rightPoint = right.codePointAt(rightIndex)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    leftIndex += leftPoint > 0xffff ? 2 : 1;
    rightIndex += rightPoint > 0xffff ? 2 : 1;
  }
  return leftIndex === left.length ? (rightIndex === right.length ? 0 : -1) : 1;
}
function snapshot(entries: readonly WorkspaceFileEntry[]): string {
  return entries.map((entry) => `${entry.kind}\0${entry.name}`).join('\0');
}
