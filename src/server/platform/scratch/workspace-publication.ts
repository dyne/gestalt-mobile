/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { constants } from 'node:fs';
import { lstat, mkdir, open, rmdir } from 'node:fs/promises';
import { dirname, join, parse, sep } from 'node:path';
import { canonicalScratchWorkspace } from './managed-scratch-owner.js';
import { privateDirectory } from './scratch-filesystem.js';

export const workspacePublicationName = '.gestalt-scratch-lock';

export async function assertParentPublications(
  workspace: string,
  logicalParents: readonly string[] = [],
) {
  const parents = new Set(logicalParents);
  let current = parse(workspace).root;
  for (const part of workspace.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (part === 'tmp') parents.add(dirname(current));
  }
  parents.delete(workspace);
  for (const parent of parents) {
    try {
      await lstat(join(parent, workspacePublicationName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error('SESSION_SCRATCH_BUSY');
  }
}

/** Shared with Launcher/Agents. No timeout, timestamp or PID grants ownership. */
export async function claimWorkspacePublication(workspace: string): Promise<() => Promise<void>> {
  await canonicalScratchWorkspace(workspace);
  const path = join(workspace, workspacePublicationName);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('SESSION_SCRATCH_BUSY');
    throw error;
  }
  await privateDirectory(path, false);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const held = await handle.stat({ bigint: true });
  let released = false;
  return async () => {
    if (released) return;
    try {
      const current = await lstat(path, { bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== held.dev ||
        current.ino !== held.ino ||
        current.birthtimeNs !== held.birthtimeNs
      )
        throw new Error('SESSION_SCRATCH_FENCE_CHANGED');
      await rmdir(path);
      released = true;
    } finally {
      await handle.close();
    }
  };
}
