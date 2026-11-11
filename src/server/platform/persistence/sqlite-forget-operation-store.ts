/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ForgetOperationStore } from '../../features/sessions/forget-session/use-case.js';
import type { SessionForgetOperation } from '../../../shared/contracts/session-forget.js';
import { canonicalSessionWorkspace } from './sqlite-workspace-lifecycle.js';
import { WorkspaceSessionConflict } from '../../features/sessions/application/workspace-conflict.js';

export class SqliteForgetOperationStore implements ForgetOperationStore {
  constructor(private readonly db: DatabaseSync) {}
  find(id: string): SessionForgetOperation | null {
    const row = this.db
      .prepare('SELECT * FROM session_forget_operations WHERE session_id = ?')
      .get(id) as
      | {
          operation_id: string;
          session_id: string;
          phase: SessionForgetOperation['phase'];
          updated_at: string;
          failure_code: SessionForgetOperation['failureCode'] | null;
          scratch_retained: number;
          blocking_session_id: string | null;
        }
      | undefined;
    return row
      ? {
          operationId: row.operation_id,
          sessionId: row.session_id,
          phase: row.phase,
          updatedAt: row.updated_at,
          ...(row.failure_code ? { failureCode: row.failure_code } : {}),
          ...(row.scratch_retained ? { scratchRetained: true as const } : {}),
          ...(row.blocking_session_id ? { blockingSessionId: row.blocking_session_id } : {}),
        }
      : null;
  }
  assertAvailable(id: string): void {
    if (this.find(id)) throw new Error('SESSION_FORGET_IN_PROGRESS');
  }
  pendingIds(): string[] {
    return (
      this.db
        .prepare("SELECT session_id FROM session_forget_operations WHERE phase != 'completed'")
        .all() as { session_id: string }[]
    ).map((row) => row.session_id);
  }
  begin(id: string): SessionForgetOperation | null {
    this.db.exec('SAVEPOINT begin_forget');
    try {
      this.db
        .prepare(
          `INSERT INTO session_forget_operations (session_id, operation_id, phase, updated_at)
      SELECT id, ?, 'stopping', ? FROM relay_sessions WHERE id = ?
      ON CONFLICT(session_id) DO NOTHING`,
        )
        .run(randomUUID(), new Date().toISOString(), id);
      const operation = this.find(id);
      if (operation && operation.phase !== 'completed') {
        const session = this.db
          .prepare('SELECT workspace_path FROM relay_sessions WHERE id=?')
          .get(id) as { workspace_path: string } | undefined;
        if (!session) throw new Error('SESSION_NOT_FOUND');
        const path = canonicalSessionWorkspace(session.workspace_path);
        this.db
          .prepare(
            'INSERT INTO workspace_forget_locks(workspace_path,session_id,operation_id) VALUES(?,?,?) ON CONFLICT(workspace_path) DO NOTHING',
          )
          .run(path, id, operation.operationId);
        const lock = this.db
          .prepare(
            'SELECT session_id, operation_id FROM workspace_forget_locks WHERE workspace_path=?',
          )
          .get(path) as { session_id: string; operation_id: string };
        if (lock.operation_id !== operation.operationId)
          throw new WorkspaceSessionConflict('SESSION_WORKSPACE_CLEANING', lock.session_id);
      }
      this.db.exec('RELEASE begin_forget');
      return operation;
    } catch (error) {
      this.db.exec('ROLLBACK TO begin_forget; RELEASE begin_forget');
      throw error;
    }
  }
  update(operation: SessionForgetOperation): SessionForgetOperation {
    this.db
      .prepare(
        `UPDATE session_forget_operations SET phase = ?, updated_at = ?, failure_code = ?, scratch_retained = ?, blocking_session_id = ?
      WHERE session_id = ? AND operation_id = ? AND phase != 'completed'`,
      )
      .run(
        operation.phase,
        operation.updatedAt,
        operation.failureCode ?? null,
        operation.scratchRetained ? 1 : 0,
        operation.blockingSessionId ?? null,
        operation.sessionId,
        operation.operationId,
      );
    return this.find(operation.sessionId)!;
  }
  finalize(operation: SessionForgetOperation): SessionForgetOperation {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.find(operation.sessionId);
      if (
        current?.operationId !== operation.operationId ||
        !['finalizing', 'completed'].includes(current.phase)
      )
        throw new Error('SESSION_FORGET_OPERATION_CHANGED');
      this.db.prepare('DELETE FROM relay_sessions WHERE id = ?').run(operation.sessionId);
      this.update({ ...operation, phase: 'completed' });
      this.db
        .prepare('DELETE FROM workspace_forget_locks WHERE operation_id=?')
        .run(operation.operationId);
      this.db.exec('COMMIT');
      return this.find(operation.sessionId)!;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
