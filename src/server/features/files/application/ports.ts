/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  ListWorkspaceDirectory,
  WorkspaceDirectoryResult,
} from '../domain/workspace-directory.js';

/** Boundary for listing one already-authorized workspace directory. */
export interface WorkspaceFileSource {
  list(workspaceRoot: string, input: ListWorkspaceDirectory): Promise<WorkspaceDirectoryResult>;
}
