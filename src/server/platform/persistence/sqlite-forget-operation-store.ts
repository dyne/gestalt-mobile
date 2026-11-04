/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ForgetOperationStore } from '../../features/sessions/forget-session/use-case.js';
import type { SessionForgetOperation } from '../../../shared/contracts/session-forget.js';

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
        }
      | undefined;
    return row
      ? {
          operationId: row.operation_id,
          sessionId: row.session_id,
          phase: row.phase,
          updatedAt: row.updated_at,
          ...(row.failure_code ? { failureCode: row.failure_code } : {}),
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
    this.db
      .prepare(
        `INSERT INTO session_forget_operations (session_id, operation_id, phase, updated_at)
      SELECT id, ?, 'stopping', ? FROM relay_sessions WHERE id = ?
      ON CONFLICT(session_id) DO NOTHING`,
      )
      .run(randomUUID(), new Date().toISOString(), id);
    return this.find(id);
  }
  update(operation: SessionForgetOperation): SessionForgetOperation {
    this.db
      .prepare(
        `UPDATE session_forget_operations SET phase = ?, updated_at = ?, failure_code = ?
      WHERE session_id = ? AND operation_id = ? AND phase != 'completed'`,
      )
      .run(
        operation.phase,
        operation.updatedAt,
        operation.failureCode ?? null,
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
      this.db.exec('COMMIT');
      return this.find(operation.sessionId)!;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
