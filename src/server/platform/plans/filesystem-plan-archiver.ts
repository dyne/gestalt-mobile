/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { WorkspacePlanArchiveSource } from '../../features/plans/application/ports.js';
import { archiveOrgPlan } from './org-plan-archive-tag.js';

type Result = Awaited<ReturnType<WorkspacePlanArchiveSource['archive']>>;

/** Adds a standard Org file tag without moving the plan or changing its tasks. */
export class FilesystemPlanArchiver implements WorkspacePlanArchiveSource {
  private readonly pending = new Map<string, Promise<Result>>();

  constructor(private readonly beforePublish: () => Promise<void> = async () => {}) {}

  async archive(workspacePath: string, planName: string): Promise<Result> {
    if (!isAbsolute(workspacePath) || !validPlanName(planName)) return { kind: 'missing' };
    const key = `${workspacePath}\0${planName}`;
    const active = this.pending.get(key);
    if (active) return active;
    const request = this.write(workspacePath, planName).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private async write(workspacePath: string, planName: string): Promise<Result> {
    try {
      const workspace = await realpath(workspacePath);
      const path = resolve(workspace, ...planName.split('/'));
      if ((await realpath(path)) !== path) return { kind: 'unavailable' };
      const parentPath = dirname(path);
      const parent = await open(
        parentPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        // Anchor publishing to the checked directory, even if a parent is renamed.
        const anchor = `/proc/self/fd/${parent.fd}`;
        if ((await realpath(anchor)) !== parentPath) return { kind: 'unavailable' };
        const target = join(anchor, basename(path));
        const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        let metadata: Stats;
        let source: string;
        try {
          metadata = await file.stat();
          if (!metadata.isFile() || metadata.size > 1_048_576) return { kind: 'unavailable' };
          source = await file.readFile('utf8');
          if (!sameFile(metadata, await file.stat())) return { kind: 'conflict' };
        } finally {
          await file.close();
        }
        const content = archiveOrgPlan(source);
        if (content === source) return { kind: 'archived' };
        const temporary = join(anchor, `.${randomUUID()}.archive`);
        try {
          await writeFile(temporary, content, { flag: 'wx', mode: metadata.mode & 0o777 });
          await this.beforePublish();
          if (
            (await realpath(parentPath)) !== parentPath ||
            (await realpath(anchor)) !== parentPath ||
            !within(workspace, await realpath(anchor))
          )
            return { kind: 'unavailable' };
          if (!sameFile(metadata, await lstat(target))) return { kind: 'conflict' };
          await rename(temporary, target);
        } finally {
          await rm(temporary, { force: true });
        }
        return { kind: 'archived' };
      } finally {
        await parent.close();
      }
    } catch (error) {
      return {
        kind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable',
      };
    }
  }
}

function sameFile(before: Stats, after: Stats): boolean {
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function within(root: string, path: string): boolean {
  const name = relative(root, path);
  return name === '' || (!isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`));
}

function validPlanName(name: string): boolean {
  const parts = name.split('/');
  return (
    name.endsWith('.org') &&
    !isAbsolute(name) &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    parts.slice(0, -1).includes('.gestalt') &&
    parts.every((part) => part !== '' && part !== '.' && part !== '..' && part !== '.git')
  );
}
