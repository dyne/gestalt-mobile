/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { DatabaseSync } from 'node:sqlite';

import type { SessionEvent } from '../../../shared/contracts/session-event.js';

export class SqliteEventJournal {
  constructor(
    private readonly db: DatabaseSync,
    private readonly retain = 2000,
  ) {}

  append(sessionId: string, type: string, payload: unknown, occurredAt: string): SessionEvent {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT next_sequence AS sequence FROM relay_sessions WHERE id = ?')
        .get(sessionId) as { sequence: number } | undefined;
      if (!row) throw new Error('SESSION_NOT_FOUND');
      this.db
        .prepare(
          'INSERT INTO session_events (session_id,sequence,occurred_at,type,payload_json) VALUES (?,?,?,?,?)',
        )
        .run(sessionId, row.sequence, occurredAt, type, JSON.stringify(payload));
      this.db
        .prepare('UPDATE relay_sessions SET next_sequence = next_sequence + 1 WHERE id = ?')
        .run(sessionId);
      this.db
        .prepare(
          'DELETE FROM session_events WHERE session_id = ? AND sequence NOT IN (SELECT sequence FROM session_events WHERE session_id = ? ORDER BY sequence DESC LIMIT ?)',
        )
        .run(sessionId, sessionId, this.retain);
      const event = { sessionId, sequence: row.sequence, type, occurredAt, payload };
      this.db.exec('COMMIT');
      return event;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  since(sessionId: string, after: number): SessionEvent[] {
    return (
      this.db
        .prepare(
          'SELECT sequence,type,occurred_at,payload_json FROM session_events WHERE session_id = ? AND sequence > ? ORDER BY sequence',
        )
        .all(sessionId, after) as Array<{
        sequence: number;
        type: string;
        occurred_at: string;
        payload_json: string;
      }>
    ).map((row) => ({
      sessionId,
      sequence: row.sequence,
      type: row.type,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json),
    }));
  }
}
