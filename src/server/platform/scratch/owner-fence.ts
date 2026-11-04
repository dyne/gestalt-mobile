/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { lstat, mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

/** An absent fence can be claimed; an existing one is never retired by age or PID. */
export async function claimOwnerFence(directory: string): Promise<(at?: string) => Promise<void>> {
  const path = join(directory, '.controller-lock');
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('SESSION_SCRATCH_BUSY');
    throw error;
  }
  const identity = await lstat(path);
  return async (at = directory) => {
    const currentPath = join(at, '.controller-lock');
    const current = await lstat(currentPath);
    if (current.dev !== identity.dev || current.ino !== identity.ino || !current.isDirectory())
      throw new Error('SESSION_SCRATCH_FENCE_CHANGED');
    await rmdir(currentPath);
  };
}
