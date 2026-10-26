/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { DatabaseSync } from 'node:sqlite';

import type { SessionEvent } from '../../../shared/contracts/session-event.js';
import { boundedAttentionReport } from '../../../shared/contracts/attention-report.js';
import { eventRetentionCutoff } from './retention.js';
import { replayOrResync, type SessionReplay } from '../events/replay.js';
import {
  mcpStartupActivity,
  parseMcpStartupStatus,
} from '../../../shared/contracts/mcp-startup-failure.js';

export const autopilotAuditEventTypes = [
  'autopilot.turn-started',
  'autopilot.turn-failed',
  'autopilot.final-rejected',
  'autopilot.executor-resumed',
  'autopilot.process-monitoring',
  'autopilot.process-result-consumed',
  'autopilot.process-terminated',
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
      json_extract(payload_json, '$.state') = 'safetyPaused'
      AND json_extract(payload_json, '$.reason') IN ('usageLimitExceeded', 'providerError')
    )
    OR (
      json_extract(payload_json, '$.state') = 'attentionRequired'
      AND json_extract(payload_json, '$.reason') IN ('noPlanProgress', 'reconcileFailed', 'actionRateExceeded')
    )
  )`;

export class SqliteEventJournal {
  constructor(
    private readonly db: DatabaseSync,
    private readonly retain?: number,
  ) {}

  append(
    sessionId: string,
    type: string,
    payload: unknown,
    occurredAt: string,
    autopilotOutboxId?: number,
  ): SessionEvent {
    if (type === 'agent.activity.mcp-startup') {
      const status = parseMcpStartupStatus(payload);
      if (!status) throw new Error('INVALID_MCP_STARTUP_STATUS');
      payload = status;
    } else if (
      type === 'activity.updated' &&
      payload &&
      typeof payload === 'object' &&
      'mcpStartup' in payload
    ) {
      const status = parseMcpStartupStatus(payload.mcpStartup);
      if (!status) throw new Error('INVALID_MCP_STARTUP_STATUS');
      payload = mcpStartupActivity(status);
    }
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
      if (this.retain !== undefined) {
        this.db
          .prepare(
            'DELETE FROM session_events WHERE session_id = ? AND sequence NOT IN (SELECT sequence FROM session_events WHERE session_id = ? ORDER BY sequence DESC LIMIT ?)',
          )
          .run(sessionId, sessionId, this.retain);
      } else {
        const cutoff = eventRetentionCutoff(occurredAt);
        if (cutoff)
          this.db
            .prepare(
              'DELETE FROM session_events WHERE session_id = ? AND julianday(occurred_at) < julianday(?)',
            )
            .run(sessionId, cutoff);
      }
      const event = { sessionId, sequence: row.sequence, type, occurredAt, payload };
      this.db.exec('COMMIT');
      return event;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  currentSequence(sessionId: string): number {
    const row = this.db
      .prepare(
        'SELECT sequence FROM session_events WHERE session_id = ? ORDER BY sequence DESC LIMIT 1',
      )
      .get(sessionId) as { sequence: number } | undefined;
    return row?.sequence ?? 0;
  }

  /** Snapshot activity excludes large agent projections and unrelated journal payloads. */
  activityHistory(sessionId: string, throughSequence: number): SessionEvent[] {
    const rows = this.db
      .prepare(
        "SELECT sequence,type,occurred_at,payload_json FROM session_events WHERE session_id = ? AND type = 'activity.updated' AND sequence <= ? ORDER BY sequence",
      )
      .all(sessionId, throughSequence) as Array<{
      sequence: number;
      type: string;
      occurred_at: string;
      payload_json: string;
    }>;
    return rows.map((row) => ({
      sessionId,
      sequence: row.sequence,
      type: row.type,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json),
    }));
  }

  /** Decide resync from bounded metadata before allocating or decoding replay payloads. */
  replay(sessionId: string, after: number): SessionReplay {
    const currentSequence = this.currentSequence(sessionId);
    const rows = this.db
      .prepare(
        'SELECT sequence,length(CAST(payload_json AS BLOB)) AS bytes FROM session_events WHERE session_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT 201',
      )
      .all(sessionId, after, currentSequence) as Array<{ sequence: number; bytes: number }>;
    if (
      rows.length > 200 ||
      rows.reduce((bytes, row) => bytes + row.bytes, 0) > 512 * 1024 ||
      (rows.length > 0 && rows[0]!.sequence !== after + 1)
    )
      return { kind: 'resync', currentSequence };
    const events = this.db
      .prepare(
        'SELECT sequence,type,occurred_at,payload_json FROM session_events WHERE session_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT 200',
      )
      .all(sessionId, after, currentSequence) as Array<{
      sequence: number;
      type: string;
      occurred_at: string;
      payload_json: string;
    }>;
    return replayOrResync(
      events.map((row) => ({
        sessionId,
        sequence: row.sequence,
        type: row.type,
        occurredAt: row.occurred_at,
        payload: JSON.parse(row.payload_json),
      })),
      after,
    );
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

  /** Same-turn root final only: never borrow another session, child, or commentary. */
  attentionReport(sessionId: string, turnId: string, requestedAt: string): string | undefined {
    const row = this.db
      .prepare(
        `
      SELECT substr(json_extract(payload_json, '$.text'), 1, 4001) AS text
      FROM session_events
      WHERE session_id = ? AND type = 'agentMessageCompleted'
        AND json_extract(payload_json, '$.turnId') = ?
        AND (
          (json_extract(payload_json, '$.phase') = 'final_answer' AND occurred_at >= ?)
          OR (json_extract(payload_json, '$.phase') = 'commentary' AND occurred_at <= ?)
        )
        AND json_type(payload_json, '$.text') = 'text'
      ORDER BY (json_extract(payload_json, '$.phase') = 'final_answer') DESC, sequence DESC LIMIT 1
    `,
      )
      .get(sessionId, turnId, requestedAt, requestedAt) as { text: string } | undefined;
    return boundedAttentionReport(row?.text);
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
