/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RelativeDirectory } from './relative-directory.js';

export type WorkspaceFileEntry = Readonly<{
  name: string;
  path: string;
  kind: 'file' | 'directory' | 'symlink';
  size?: number;
  modifiedAt?: string;
}>;

export type ListWorkspaceDirectory = Readonly<{
  directory: RelativeDirectory;
  cursor?: string;
  limit: number;
}>;

export type WorkspaceDirectoryPage = Readonly<{
  directory: RelativeDirectory;
  entries: readonly WorkspaceFileEntry[];
  nextCursor?: string;
}>;

export type WorkspaceDirectoryResult =
  | Readonly<{ kind: 'available'; page: WorkspaceDirectoryPage }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'not-directory' }>
  | Readonly<{ kind: 'unreadable' }>
  | Readonly<{ kind: 'invalid-cursor' }>
  | Readonly<{ kind: 'stale-cursor' }>;
