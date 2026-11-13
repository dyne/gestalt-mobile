/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeReleaseStore } from '../../features/sessions/application/runtime-release-store.js';
import type { RelaySessionSnapshot } from '../../features/sessions/model/relay-session.js';

export class SqliteRuntimeReleaseStore implements RuntimeReleaseStore {
  constructor(private readonly db: DatabaseSync) {}

  confirmed(session: RelaySessionSnapshot): boolean {
    return Boolean(
      session.threadId &&
      this.db
        .prepare(
          'SELECT 1 FROM session_runtime_releases WHERE session_id=? AND workspace_path=? AND thread_id=?',
        )
        .get(session.id, session.workspacePath, session.threadId),
    );
  }

  confirm(session: RelaySessionSnapshot): void {
    if (!session.threadId) return;
    this.db
      .prepare(
        'INSERT INTO session_runtime_releases (session_id,workspace_path,thread_id) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET workspace_path=excluded.workspace_path,thread_id=excluded.thread_id',
      )
      .run(session.id, session.workspacePath, session.threadId);
  }

  invalidate(sessionId: string): void {
    this.db.prepare('DELETE FROM session_runtime_releases WHERE session_id=?').run(sessionId);
  }
}
