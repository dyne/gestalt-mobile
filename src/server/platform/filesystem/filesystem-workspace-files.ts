/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
type MutationHooks = Readonly<{
  afterParentCheck?: (operation: 'upload' | 'copy' | 'move' | 'delete') => Promise<void>;
  beforePublish?: (operation: 'upload' | 'copy' | 'move') => Promise<void>;
}>;
type AnchoredDirectory = Readonly<{ path: string; close: () => Promise<void> }>;

/** Lists exactly one directory; symlinks are represented but never followed. */
export class FilesystemWorkspaceFiles implements WorkspaceFileSource {
  private readonly cursors = new Map<string, Cursor>();

  constructor(
    private readonly filesystem: Filesystem = { lstat, readdir, realpath, stat },
    private readonly mutationHooks: MutationHooks = {},
  ) {}

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
    const parent = await anchoredDirectory(root, input.directory);
    if (!parent) return { kind: 'invalid-destination' };
    try {
      await this.mutationHooks.afterParentCheck?.('upload');
      if (!(await stableAnchor(root, input.directory, parent.path)))
        return { kind: 'invalid-destination' };
      const target = await this.targetName(parent.path, input.filename, input.conflict, 'file');
      if (typeof target !== 'string') return target;
      const temp = join(parent.path, `.${randomUUID()}.upload`);
      await writeFile(temp, input.content, { flag: 'wx' });
      try {
        await this.mutationHooks.beforePublish?.('upload');
        await this.publishFile(temp, target, input.conflict);
      } finally {
        await rm(temp, { force: true }).catch(() => undefined);
      }
      return {
        kind: 'available',
        source: '',
        path: input.directory ? `${input.directory}/${basename(target)}` : basename(target),
        entryKind: 'file',
        conflict: input.conflict,
      };
    } catch {
      return { kind: 'unreadable' };
    } finally {
      await parent.close();
    }
  }

  async delete(rootPath: string, input: DeleteInput): Promise<FileMutationResult> {
    if (!input.recursive) return { kind: 'invalid-destination' };
    if (input.path === '.git' || input.path.startsWith('.git/')) return { kind: 'protected' };
    if (!validRelative(input.path)) return { kind: 'invalid-destination' };
    const root = await this.canonicalDirectory(rootPath);
    if (!root) return { kind: 'unreadable' };
    const parent = await anchoredDirectory(root, dirnameRelative(input.path));
    if (!parent) return { kind: 'missing' };
    try {
      await this.mutationHooks.afterParentCheck?.('delete');
      if (!(await stableAnchor(root, dirnameRelative(input.path), parent.path)))
        return { kind: 'missing' };
      const target = join(parent.path, basename(input.path));
      const metadata = await safeLstat(target);
      if (!metadata || metadata.isSymbolicLink()) return { kind: 'missing' };
      await rm(target, { recursive: metadata.isDirectory(), force: false });
      return {
        kind: 'available',
        source: input.path,
        path: input.path,
        entryKind: metadata.isDirectory() ? 'directory' : 'file',
        conflict: 'reject',
      };
    } catch {
      return { kind: 'unreadable' };
    } finally {
      await parent.close();
    }
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
    const sourceParent = await anchoredDirectory(root, dirnameRelative(input.source));
    if (!sourceParent) return { kind: 'missing' };
    const parent = await anchoredDirectory(root, input.destinationDirectory);
    if (!parent) {
      await sourceParent.close();
      return { kind: 'invalid-destination' };
    }
    const source = join(sourceParent.path, basename(input.source));
    const sourceMetadata = await safeLstat(source);
    if (!sourceMetadata || sourceMetadata.isSymbolicLink()) {
      await Promise.all([sourceParent.close(), parent.close()]);
      return { kind: 'missing' };
    }
    if (dirnameRelative(input.source) === input.destinationDirectory && moving) {
      await Promise.all([sourceParent.close(), parent.close()]);
      return { kind: 'same-parent' };
    }
    if (
      sourceMetadata.isDirectory() &&
      (input.destinationDirectory === input.source ||
        input.destinationDirectory.startsWith(`${input.source}/`))
    ) {
      await Promise.all([sourceParent.close(), parent.close()]);
      return { kind: 'source-inside-destination' };
    }
    const target = await this.targetName(
      parent.path,
      basename(source),
      input.conflict,
      sourceMetadata.isFile() ? 'file' : 'directory',
    );
    if (typeof target !== 'string') {
      await Promise.all([sourceParent.close(), parent.close()]);
      return target;
    }
    try {
      await this.mutationHooks.afterParentCheck?.(moving ? 'move' : 'copy');
      if (
        !(await stableAnchor(root, dirnameRelative(input.source), sourceParent.path)) ||
        !(await stableAnchor(root, input.destinationDirectory, parent.path))
      )
        return { kind: 'invalid-destination' };
      await this.mutationHooks.beforePublish?.(moving ? 'move' : 'copy');
      if (moving) {
        await this.publishMove(source, target, input.conflict, sourceMetadata.isDirectory());
      } else if (sourceMetadata.isFile()) {
        const temp = join(parent.path, `.${randomUUID()}.copy`);
        try {
          const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            await copyFile(procPath(sourceHandle.fd), temp, 0);
          } finally {
            await sourceHandle.close();
          }
          await this.publishFile(temp, target, input.conflict);
        } finally {
          await rm(temp, { force: true }).catch(() => undefined);
        }
      } else {
        const temp = join(parent.path, `.${randomUUID()}.copy-directory`);
        try {
          const sourceDirectory = await openDirectory(source);
          if (!sourceDirectory) throw new Error('source changed');
          try {
            await copyTree(sourceDirectory.path, temp, true);
          } finally {
            await sourceDirectory.close();
          }
          await this.publishDirectory(temp, target, input.conflict);
        } finally {
          await rm(temp, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      return {
        kind: 'available',
        source: input.source,
        path: input.destinationDirectory
          ? `${input.destinationDirectory}/${basename(target)}`
          : basename(target),
        entryKind: sourceMetadata.isDirectory() ? 'directory' : 'file',
        conflict: input.conflict,
      };
    } catch {
      return { kind: 'unreadable' };
    } finally {
      await Promise.all([sourceParent.close(), parent.close()]);
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
    const reservation = conflict === 'replace' ? null : await reserveFile(target);
    try {
      await rename(temp, target);
    } catch (error) {
      if (reservation) await removeReservation(target, reservation, false);
      throw error;
    }
  }

  private async publishDirectory(temp: string, target: string, conflict: string): Promise<void> {
    const reservation = conflict === 'replace' ? null : await reserveDirectory(target);
    try {
      await rename(temp, target);
    } catch (error) {
      if (reservation) await removeReservation(target, reservation, true);
      throw error;
    }
  }

  private async publishMove(
    source: string,
    target: string,
    conflict: string,
    directory: boolean,
  ): Promise<void> {
    const reservation =
      conflict === 'replace'
        ? null
        : directory
          ? await reserveDirectory(target)
          : await reserveFile(target);
    try {
      await rename(source, target);
    } catch (error) {
      if (reservation) await removeReservation(target, reservation, directory);
      throw error;
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
function dirnameRelative(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}
function procPath(fd: number): string {
  return `/proc/self/fd/${fd}`;
}
async function openDirectory(path: string): Promise<AnchoredDirectory | null> {
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    return { path: procPath(handle.fd), close: () => handle.close() };
  } catch {
    return null;
  }
}
async function anchoredDirectory(
  root: string,
  directory: string,
): Promise<AnchoredDirectory | null> {
  if (directory !== '' && !validRelative(directory)) return null;
  let current = await openDirectory(root);
  if (!current) return null;
  for (const segment of directory === '' ? [] : directory.split('/')) {
    const next = await openDirectory(join(current.path, segment));
    await current.close();
    if (!next) return null;
    current = next;
  }
  return current;
}
async function reserveFile(path: string): Promise<Stats> {
  const reservation = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    return await reservation.stat();
  } finally {
    await reservation.close();
  }
}
async function reserveDirectory(path: string): Promise<Stats> {
  await mkdir(path);
  return lstat(path);
}
async function removeReservation(
  path: string,
  reservation: Stats,
  directory: boolean,
): Promise<void> {
  const current = await safeLstat(path);
  if (current?.dev === reservation.dev && current.ino === reservation.ino)
    await rm(path, { recursive: directory, force: true }).catch(() => undefined);
}
async function stableAnchor(root: string, directory: string, anchor: string): Promise<boolean> {
  try {
    const current = await realpath(directory ? join(root, ...directory.split('/')) : root);
    const anchored = await realpath(anchor);
    return current === anchored && within(root, anchored);
  } catch {
    return false;
  }
}
async function copyTree(source: string, target: string, directory: boolean): Promise<void> {
  if (!directory) {
    const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await copyFile(procPath(sourceHandle.fd), target, 0);
    } finally {
      await sourceHandle.close();
    }
    return;
  }
  await mkdir(target);
  for (const name of await readdir(source)) {
    const childSource = join(source, name);
    const metadata = await lstat(childSource);
    if (metadata.isSymbolicLink() || name === '.git') throw new Error('unsupported source');
    if (metadata.isDirectory()) {
      const child = await openDirectory(childSource);
      if (!child) throw new Error('source changed');
      try {
        await copyTree(child.path, join(target, name), true);
      } finally {
        await child.close();
      }
    } else {
      await copyTree(childSource, join(target, name), false);
    }
  }
}
