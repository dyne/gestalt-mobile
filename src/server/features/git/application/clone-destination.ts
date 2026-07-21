/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { GitWorkspaceResolver } from './ports.js';

export type CloneDestinationResult =
  | { ok: true; path: string }
  | {
      ok: false;
      statusCode: 404 | 409;
      code: 'WORKSPACE_NOT_FOUND' | 'WORKSPACE_IS_GIT_REPOSITORY';
    };

export async function resolveCloneDestination(
  workspaces: GitWorkspaceResolver,
  workspaceId: string,
): Promise<CloneDestinationResult> {
  const workspace = await workspaces.resolveGitWorkspace(workspaceId);
  if (!workspace) return { ok: false, statusCode: 404, code: 'WORKSPACE_NOT_FOUND' };
  if (workspace.isGitRepository)
    return { ok: false, statusCode: 409, code: 'WORKSPACE_IS_GIT_REPOSITORY' };
  return { ok: true, path: workspace.path };
}
