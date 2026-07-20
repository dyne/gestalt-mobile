/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * A selectable directory in the catalog rooted at the relay's configured cwd.
 *
 * `id` is the only client input accepted for resolving a directory on the server.
 * The root node is selectable and uses `.` as its relative path. Repository nodes
 * are terminal and therefore always have an empty `children` array.
 */
export type WorkspaceOption = {
  id: string;
  name: string;
  relativePath: string;
  isGitRepository: boolean;
  children: WorkspaceOption[];
};
export type ProfileOption = {
  name: string;
  state: 'ok' | 'not_logged_in' | 'error';
  status: string;
};
export interface WorkspaceCatalog {
  list(): Promise<WorkspaceOption[]>;
  resolve(workspaceId: string): Promise<{ id: string; name: string; realPath: string }>;
}
export interface ProfileCatalog {
  list(): Promise<ProfileOption[]>;
  require(name: string): Promise<ProfileOption>;
}
