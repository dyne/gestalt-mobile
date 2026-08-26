/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { WorkspaceFileSource } from '../../features/files/application/ports.js';
import type {
  CopyMoveInput,
  DeleteInput,
  FileMutationResult,
  UploadInput,
} from '../../features/files/application/ports.js';
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

  async copy(rootPath: string, input: CopyMoveInput): Promise<FileMutationResult> {
    return this.transfer(rootPath, input, false);
  }

  async move(rootPath: string, input: CopyMoveInput): Promise<FileMutationResult> {
    return this.transfer(rootPath, input, true);
  }

  async upload(rootPath: string, input: UploadInput): Promise<FileMutationResult> {
    if (!validName(input.filename)) return { kind: 'invalid-destination' };
    const root = await this.canonicalDirectory(rootPath);
    if (!root) return { kind: 'unreadable' };
    const parent = await this.safeDirectory(root, input.directory);
    if (!parent) return { kind: 'invalid-destination' };
    const target = await this.targetName(parent, input.filename, input.conflict, 'file');
    if (typeof target !== 'string') return target;
    const temp = join(parent, `.${randomUUID()}.upload`);
    try {
      await writeFile(temp, input.content, { flag: 'wx' });
      await this.publishFile(temp, target, input.conflict);
      return {
        kind: 'available',
        source: '',
        path: relative(root, target).split(sep).join('/'),
        entryKind: 'file',
        conflict: input.conflict,
      };
    } catch {
      await rm(temp, { force: true }).catch(() => undefined);
      return { kind: 'unreadable' };
    }
  }

  async delete(rootPath: string, input: DeleteInput): Promise<FileMutationResult> {
    if (!input.recursive) return { kind: 'invalid-destination' };
    if (input.path === '.git' || input.path.startsWith('.git/')) return { kind: 'protected' };
    if (!validRelative(input.path)) return { kind: 'invalid-destination' };
    const root = await this.canonicalDirectory(rootPath);
    if (!root) return { kind: 'unreadable' };
    const entry = await this.safeEntry(root, input.path);
    if (!entry) return { kind: 'missing' };
    const { path: target, metadata } = entry;
    try {
      await rm(target, { recursive: metadata.isDirectory(), force: false });
    } catch {
      return { kind: 'unreadable' };
    }
    return {
      kind: 'available',
      source: input.path,
      path: input.path,
      entryKind: metadata.isDirectory() ? 'directory' : 'file',
      conflict: 'reject',
    };
  }

  private async transfer(
    rootPath: string,
    input: CopyMoveInput,
    moving: boolean,
  ): Promise<FileMutationResult> {
    if (
      !validRelative(input.source) ||
      (input.destinationDirectory !== '' && !validRelative(input.destinationDirectory))
    )
      return { kind: 'invalid-destination' };
    const root = await this.canonicalDirectory(rootPath);
    if (!root) return { kind: 'unreadable' };
    if (input.source === '.git' || input.source.startsWith('.git/')) return { kind: 'protected' };
    const sourceEntry = await this.safeEntry(root, input.source);
    if (!sourceEntry) return { kind: 'missing' };
    const { path: source, metadata: sourceMetadata } = sourceEntry;
    const parent = await this.safeDirectory(root, input.destinationDirectory);
    if (!parent) return { kind: 'invalid-destination' };
    if (dirname(source) === parent && moving) return { kind: 'same-parent' };
    if (sourceMetadata.isDirectory() && (parent === source || parent.startsWith(`${source}${sep}`)))
      return { kind: 'source-inside-destination' };
    const target = await this.targetName(
      parent,
      basename(source),
      input.conflict,
      sourceMetadata.isFile() ? 'file' : 'directory',
    );
    if (typeof target !== 'string') return target;
    try {
      if (sourceMetadata.isFile()) {
        const temp = join(parent, `.${randomUUID()}.copy`);
        try {
          await copyFile(source, temp, 0);
          await this.publishFile(temp, target, input.conflict);
        } finally {
          await rm(temp, { force: true }).catch(() => undefined);
        }
        if (moving) await unlink(source);
      } else {
        const temp = join(parent, `.${randomUUID()}.copy-directory`);
        try {
          await copyTree(source, temp, true);
          await this.publishDirectory(temp, target);
        } finally {
          await rm(temp, { recursive: true, force: true }).catch(() => undefined);
        }
        if (moving) await rm(source, { recursive: true, force: false });
      }
      return {
        kind: 'available',
        source: input.source,
        path: relative(root, target).split(sep).join('/'),
        entryKind: sourceMetadata.isDirectory() ? 'directory' : 'file',
        conflict: input.conflict,
      };
    } catch {
      return { kind: 'unreadable' };
    }
  }

  private async safeDirectory(root: string, directory: string): Promise<string | null> {
    if (directory !== '' && !validRelative(directory)) return null;
    const entry = await this.safeEntry(root, directory, true);
    return entry?.metadata.isDirectory() ? entry.path : null;
  }

  private async targetName(
    parent: string,
    name: string,
    conflict: string,
    sourceKind: 'file' | 'directory',
  ): Promise<string | Exclude<FileMutationResult, { kind: 'available' }>> {
    let target = join(parent, name);
    const existing = await safeLstat(target);
    if (!existing) return target;
    if (existing.isSymbolicLink()) return { kind: 'symlink' };
    if (conflict === 'reject')
      return { kind: 'conflict', replaceAllowed: sourceKind === 'file' && existing.isFile() };
    if (conflict === 'replace') {
      if (sourceKind !== 'file' || !existing.isFile()) return { kind: 'replace-unsupported' };
      return target;
    }
    const extension = extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    for (let index = 1; index < 10000; index += 1) {
      target = join(parent, `${stem} (${index === 1 ? 'copy' : index})${extension}`);
      if (!(await safeLstat(target))) return target;
    }
    return { kind: 'unreadable' };
  }

  private async safeEntry(
    root: string,
    value: string,
    allowRoot = false,
  ): Promise<{ path: string; metadata: Stats } | null> {
    if (value === '' && !allowRoot) return null;
    let path = root;
    for (const segment of value === '' ? [] : value.split('/')) {
      if (!validName(segment)) return null;
      path = join(path, segment);
      const metadata = await safeLstat(path);
      if (!metadata || metadata.isSymbolicLink()) return null;
      try {
        if (!within(root, await realpath(path))) return null;
      } catch {
        return null;
      }
    }
    const metadata = await safeLstat(path);
    return metadata && !metadata.isSymbolicLink() ? { path, metadata } : null;
  }

  private async publishFile(temp: string, target: string, conflict: string): Promise<void> {
    if (conflict === 'keep-both') {
      await link(temp, target);
      await unlink(temp);
      return;
    }
    await rename(temp, target);
  }

  private async publishDirectory(temp: string, target: string): Promise<void> {
    const existing = await safeLstat(target);
    if (existing) throw new Error('destination raced');
    await rename(temp, target);
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

function validRelative(value: string): boolean {
  return (
    value !== '' &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    value.split('/').every(validName)
  );
}
function validName(value: string): boolean {
  return (
    value !== '' &&
    value !== '.' &&
    value !== '..' &&
    value !== '.git' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}
async function safeLstat(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}
async function copyTree(source: string, target: string, directory: boolean): Promise<void> {
  if (!directory) {
    await copyFile(source, target, 0);
    return;
  }
  await mkdir(target);
  for (const name of await readdir(source)) {
    const childSource = join(source, name);
    const metadata = await lstat(childSource);
    if (metadata.isSymbolicLink() || name === '.git') throw new Error('unsupported source');
    await copyTree(childSource, join(target, name), metadata.isDirectory());
  }
}
