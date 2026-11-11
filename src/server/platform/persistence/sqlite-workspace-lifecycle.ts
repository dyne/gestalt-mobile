/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { RelaySessionSnapshot } from '../../features/sessions/model/relay-session.js';
import { WorkspaceSessionConflict } from '../../features/sessions/application/workspace-conflict.js';

export function canonicalSessionWorkspace(path: string): string {
  if (!isAbsolute(path)) throw new Error('SESSION_SCRATCH_UNSAFE_PATH');
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path);
    throw error;
  }
}

export function workspaceContains(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
  );
}

/** Called inside the repository's write transaction, before publication or native startup. */
export class SqliteWorkspaceLifecycle {
  constructor(private readonly db: DatabaseSync) {}
  assertSave(session: RelaySessionSnapshot, requireAdmission = false): void {
    const path = canonicalSessionWorkspace(session.workspacePath);
    const prior = this.db
      .prepare('SELECT workspace_path,state,desired_state FROM relay_sessions WHERE id=?')
      .get(session.id) as
      { workspace_path: string; state: string; desired_state: string } | undefined;
    const running =
      session.desiredState === 'active' && !['stopped', 'released'].includes(session.state);
    const alreadyRunning =
      prior &&
      canonicalSessionWorkspace(prior.workspace_path) === path &&
      prior.desired_state === 'active' &&
      !['stopped', 'released'].includes(prior.state);
    if (
      !prior ||
      canonicalSessionWorkspace(prior.workspace_path) !== path ||
      (running && (!alreadyRunning || requireAdmission))
    ) {
      for (const lock of this.db.prepare('SELECT * FROM workspace_forget_locks').all() as {
        workspace_path: string;
        session_id: string;
      }[]) {
        if (
          path === lock.workspace_path ||
          workspaceContains(join(lock.workspace_path, 'tmp'), path)
        )
          throw new WorkspaceSessionConflict('SESSION_WORKSPACE_CLEANING', lock.session_id);
      }
    }
    if (!running || (alreadyRunning && !requireAdmission)) return;
    for (const other of this.db
      .prepare(
        "SELECT id,workspace_path FROM relay_sessions WHERE id != ? AND desired_state='active' AND state NOT IN ('stopped','released')",
      )
      .all(session.id) as { id: string; workspace_path: string }[]) {
      if (canonicalSessionWorkspace(other.workspace_path) === path)
        throw new WorkspaceSessionConflict('SESSION_WORKSPACE_BUSY', other.id);
    }
  }
}
