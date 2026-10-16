/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { lstatSync, readFileSync, readdirSync } from 'node:fs';

/** Host observation of the actual target mount view; a visible empty directory is not denial. */
export function observeNativeDeniedPath(pid: number, path: string): boolean {
  const actual = `/proc/${pid}/root${path}`;
  try {
    const info = lstatSync(path);
    if (info.isDirectory()) readdirSync(actual);
    else readFileSync(actual);
    return false;
  } catch (error) {
    return ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(
      (error as NodeJS.ErrnoException).code ?? '',
    );
  }
}
