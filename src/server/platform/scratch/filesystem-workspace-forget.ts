/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { lstatSync, mkdirSync, realpathSync, renameSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { ScratchSessionOwner } from '../../features/sessions/clean-tmp/use-case.js';
import { WorkspaceSessionConflict } from '../../features/sessions/application/workspace-conflict.js';
import {
  WorkspaceCleanupFailure,
  type ForgetCleanupResult,
} from '../../features/sessions/forget-session/use-case.js';
import {
  canonicalSessionWorkspace,
  workspaceContains,
} from '../persistence/sqlite-workspace-lifecycle.js';
import { FilesystemScratchCleanup } from './filesystem-scratch-cleanup.js';
import { claimWorkspacePublication } from './workspace-publication.js';
import { hasRuntimeOwner } from './runtime-root.js';

/** Final Forget owns the entire selected workspace's explicitly disposable tmp directory. */
export class FilesystemWorkspaceForget {
  constructor(private readonly db: DatabaseSync) {}
  async clean(
    session: ScratchSessionOwner,
    operationId: string,
    authorized: () => boolean,
    knownSessions: () => readonly ScratchSessionOwner[],
  ): Promise<ForgetCleanupResult> {
    const workspace = canonicalSessionWorkspace(session.workspacePath);
    const others = knownSessions().filter((other) => other.id !== session.id);
    if (others.some((other) => canonicalSessionWorkspace(other.workspacePath) === workspace))
      return new FilesystemScratchCleanup().cleanSession(session, authorized, knownSessions, {
        retainBorrowed: true,
      });
    const temporary = join(workspace, 'tmp');
    for (const other of others) {
      if (workspaceContains(temporary, canonicalSessionWorkspace(other.workspacePath)))
        throw new WorkspaceSessionConflict('SESSION_NESTED_WORKSPACE', other.id);
    }
    try {
      await lstat(workspace);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await new FilesystemScratchCleanup().cleanSession(session, authorized, knownSessions);
      return;
    }
    // Keep the physical publication fence through durable finalization. It is
    // outside tmp, so a retiring namespace cannot hide it from new publishers.
    const release = await claimWorkspacePublication(workspace);
    let cleanupFolders = ['tmp'];
    try {
      const cleanup = new FilesystemScratchCleanup();
      await cleanup.retireNestedNamespaces(
        temporary,
        knownSessions,
        authorized,
        session.id,
        undefined,
        true,
      );
      const counts = await cleanup.cleanWorkspace(
        workspace,
        knownSessions,
        undefined,
        authorized,
        session.id,
      );
      if (counts.skipped || counts.failed) {
        if (counts.failedFolders?.length)
          cleanupFolders = counts.failedFolders.map(({ relativePath }) => relativePath);
        // An earlier completed Forget may have left a borrower in this workspace.
        // Its release is independent of the last session. Keep tmp in place.
        if (
          !counts.failed &&
          counts.leasedMobileSessions.length === counts.skipped &&
          counts.leasedMobileSessions.every(({ sessionId }) => this.previouslyRetained(sessionId))
        ) {
          const retained = new Set(
            counts.leasedMobileSessions.flatMap(({ runtimeDirectory }) => runtimeDirectory ?? []),
          );
          if (
            (!process.getuid || !(await hasRuntimeOwner({ workspacePath: workspace }, retained))) &&
            authorized()
          )
            return { release, scratchRetained: true };
        }
        throw new Error('SESSION_CLEANUP_FAILED');
      }
      cleanupFolders = [];
      if (process.getuid && (await hasRuntimeOwner({ workspacePath: workspace })))
        throw new Error('SESSION_CLEANUP_FAILED');
      cleanupFolders = ['tmp'];
      const retired = this.retire(session, operationId, workspace, temporary, authorized);
      if (retired) {
        cleanupFolders = [`.gestalt/forgotten-tmp/${operationId}`];
        await this.assertRetired(retired);
        await rm(retired, { recursive: true, force: true, maxRetries: 3 });
      }
      cleanupFolders = ['tmp'];
      // A non-cooperating external publisher must not turn retained files into a
      // successful final Forget. New Mobile starts remain durably fenced.
      try {
        await lstat(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { release };
        throw error;
      }
      throw new Error('SESSION_CLEANUP_FAILED');
    } catch (error) {
      await release();
      if (cleanupFolders.length) throw new WorkspaceCleanupFailure(cleanupFolders, error);
      throw error;
    }
  }

  private previouslyRetained(id: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM session_forget_operations WHERE session_id=? AND phase='completed' AND scratch_retained=1",
      )
      .get(id);
  }

  private async assertRetired(directory: string | Buffer, depth = 0): Promise<void> {
    if (depth > 128) throw new Error('SESSION_CLEANUP_FAILED');
    let entries;
    try {
      entries = await readdir(directory, { encoding: 'buffer', withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (
        [
          '.gestalt-owner.json',
          '.gestalt-runtime.json',
          '.controller-lock',
          '.containment-lock',
          '.gestalt-scratch-lock',
        ].includes(entry.name.toString())
      )
        throw new Error('SESSION_CLEANUP_FAILED');
      if (entry.isDirectory() && !entry.isSymbolicLink())
        await this.assertRetired(
          Buffer.concat([Buffer.from(directory), Buffer.from('/'), entry.name]),
          depth + 1,
        );
    }
  }

  private retire(
    session: ScratchSessionOwner,
    operationId: string,
    workspace: string,
    temporary: string,
    authorized: () => boolean,
  ): string {
    // The short synchronous transaction atomically checks authority and moves
    // tmp out of the allocation namespace. Duplicate/restarted requests can
    // delete only this operation's retired path, never a later session's tmp.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lock = this.db
        .prepare(
          'SELECT retired_path FROM workspace_forget_locks WHERE workspace_path=? AND operation_id=?',
        )
        .get(workspace, operationId) as { retired_path: string | null } | undefined;
      if (!lock || !authorized()) throw new Error('SESSION_FORGET_OPERATION_CHANGED');
      if (lock.retired_path !== null) {
        if (
          lock.retired_path !== '' &&
          lock.retired_path !== join(workspace, '.gestalt', 'forgotten-tmp', operationId)
        )
          throw new Error('SESSION_SCRATCH_UNSAFE_PATH');
        this.db.exec('COMMIT');
        return lock.retired_path;
      }
      if (!/^[0-9a-f-]{36}$/.test(operationId)) throw new Error('SESSION_FORGET_OPERATION_CHANGED');
      const directory = (path: string) => {
        const info = lstatSync(path);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          realpathSync(path) !== path ||
          (process.getuid && info.uid !== process.getuid())
        )
          throw new Error('SESSION_SCRATCH_UNSAFE_PATH');
      };
      let retired = '';
      try {
        directory(workspace);
        directory(temporary);
        const metadata = join(workspace, '.gestalt');
        const staging = join(metadata, 'forgotten-tmp');
        for (const path of [metadata, staging]) {
          try {
            mkdirSync(path, { mode: 0o700 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
          directory(path);
        }
        retired = join(staging, operationId);
        try {
          lstatSync(retired);
          throw new Error('SESSION_SCRATCH_BUSY');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        renameSync(temporary, retired);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // A crash between rename and commit leaves the exact durable operation's
        // private retirement directory. Recover it without touching a new tmp.
        const candidate = join(workspace, '.gestalt', 'forgotten-tmp', operationId);
        try {
          directory(candidate);
          retired = candidate;
        } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing;
        }
      }
      this.db
        .prepare('UPDATE workspace_forget_locks SET retired_path=? WHERE operation_id=?')
        .run(retired, operationId);
      this.db.exec('COMMIT');
      return retired;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
