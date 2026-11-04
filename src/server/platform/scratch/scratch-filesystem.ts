/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';

export const scratchMarkerName = '.gestalt-owner.json';
export const scratchContextVariable = 'GESTALT_SESSION_TMP_CONTEXT';

export function mobileScratchOwnerId(sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(sessionId))
    throw new Error('SESSION_SCRATCH_INVALID_ID');
  return `mobile-${createHash('sha256').update(sessionId).digest('hex')}`;
}

/** Reject links and foreign directories; never repair their permissions or contents. */
export async function privateDirectory(path: string, create: boolean): Promise<boolean> {
  let created = false;
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error('SESSION_SCRATCH_UNSAFE_PATH');
  if (process.getuid && info.uid !== process.getuid())
    throw new Error('SESSION_SCRATCH_FOREIGN_OWNER');
  if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o700)
    throw new Error('SESSION_SCRATCH_NOT_PRIVATE');
  return created;
}

export async function readMarker(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > 16384 ||
      (process.getuid && info.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
    )
      throw new Error('SESSION_SCRATCH_UNSAFE_MARKER');
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}
