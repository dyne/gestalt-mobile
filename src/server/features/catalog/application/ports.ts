/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type WorkspaceOption = { id: string; name: string; isGitRepository: boolean };
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
