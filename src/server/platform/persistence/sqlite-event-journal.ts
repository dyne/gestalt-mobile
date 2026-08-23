/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { DatabaseSync } from 'node:sqlite';

import type { SessionEvent } from '../../../shared/contracts/session-event.js';

export const autopilotAuditEventTypes = [
  'autopilot.turn-started',
  'autopilot.turn-failed',
  'autopilot.updated',
  'org-plan.attention-required',
  'org-plan.attention-resolved',
] as const;

/**
 * Not every coordinator state publication is useful as a timeline record.
 * Keep this predicate in SQL so a burst of routine `monitoring` updates cannot
 * consume the bounded, user-visible audit tail.
 */
const renderableAutopilotAuditWhere = `
  type IN (${autopilotAuditEventTypes.map(() => '?').join(',')})
  AND (
    type <> 'autopilot.updated'
    OR json_extract(payload_json, '$.state') = 'completed'
    OR (
      json_extract(payload_json, '$.state') = 'attentionRequired'
      AND json_extract(payload_json, '$.reason') IN ('noPlanProgress', 'reconcileFailed')
    )
  )`;

export class SqliteEventJournal {
  constructor(
    private readonly db: DatabaseSync,
    private readonly retain = 2000,
  ) {}

  append(
    sessionId: string,
    type: string,
    payload: unknown,
    occurredAt: string,
    autopilotOutboxId?: number,
  ): SessionEvent {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT next_sequence AS sequence FROM relay_sessions WHERE id = ?')
        .get(sessionId) as { sequence: number } | undefined;
      if (!row) throw new Error('SESSION_NOT_FOUND');
      const inserted = this.db
        .prepare(
          'INSERT OR IGNORE INTO session_events (session_id,sequence,occurred_at,type,payload_json,autopilot_outbox_id) VALUES (?,?,?,?,?,?)',
        )
        .run(
          sessionId,
          row.sequence,
          occurredAt,
          type,
          JSON.stringify(payload),
          autopilotOutboxId ?? null,
        );
      if (inserted.changes === 0 && autopilotOutboxId !== undefined) {
        const existing = this.db
          .prepare(
            'SELECT sequence,type,occurred_at,payload_json FROM session_events WHERE session_id = ? AND autopilot_outbox_id = ?',
          )
          .get(sessionId, autopilotOutboxId) as
          { sequence: number; type: string; occurred_at: string; payload_json: string } | undefined;
        if (existing) {
          this.db.exec('COMMIT');
          return {
            sessionId,
            sequence: existing.sequence,
            type: existing.type,
            occurredAt: existing.occurred_at,
            payload: JSON.parse(existing.payload_json),
          };
        }
      }
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

  /** Bounded chronological tail for redacted timeline projections. */
  tail(sessionId: string, limit: number): SessionEvent[] {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    return (
      this.db
        .prepare(
          'SELECT sequence,type,occurred_at,payload_json FROM session_events WHERE session_id = ? ORDER BY sequence DESC LIMIT ?',
        )
        .all(sessionId, safeLimit) as Array<{
        sequence: number;
        type: string;
        occurred_at: string;
        payload_json: string;
      }>
    )
      .reverse()
      .map((row) => ({
        sessionId,
        sequence: row.sequence,
        type: row.type,
        occurredAt: row.occurred_at,
        payload: JSON.parse(row.payload_json),
      }));
  }

  tailWithTruncation(
    sessionId: string,
    limit: number,
  ): { events: SessionEvent[]; truncated: boolean } {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const events = this.tail(sessionId, safeLimit);
    const oldest = events.at(0)?.sequence;
    const truncated =
      oldest !== undefined &&
      Boolean(
        this.db
          .prepare(
            'SELECT 1 AS present FROM session_events WHERE session_id = ? AND sequence < ? LIMIT 1',
          )
          .get(sessionId, oldest),
      );
    return { events, truncated };
  }

  /**
   * Reads only audit-bearing rows. A generic journal tail can otherwise be
   * filled with chat deltas and incorrectly report an empty audit history.
   */
  autopilotAuditTail(
    sessionId: string,
    limit: number,
  ): { events: SessionEvent[]; truncated: boolean } {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const rows = this.db
      .prepare(
        `SELECT sequence,type,occurred_at,payload_json FROM session_events WHERE session_id = ? AND ${renderableAutopilotAuditWhere} ORDER BY sequence DESC LIMIT ?`,
      )
      .all(sessionId, ...autopilotAuditEventTypes, safeLimit) as Array<{
      sequence: number;
      type: string;
      occurred_at: string;
      payload_json: string;
    }>;
    const events = rows.reverse().map((row) => ({
      sessionId,
      sequence: row.sequence,
      type: row.type,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json),
    }));
    const oldest = events.at(0)?.sequence;
    const truncated =
      oldest !== undefined &&
      Boolean(
        this.db
          .prepare(
            `SELECT 1 AS present FROM session_events WHERE session_id = ? AND sequence < ? AND ${renderableAutopilotAuditWhere} LIMIT 1`,
          )
          .get(sessionId, oldest, ...autopilotAuditEventTypes),
      );
    return { events, truncated };
  }
}
