/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { DatabaseSync } from 'node:sqlite';

import type {
  AutopilotControl,
  AutopilotAuditEvent,
  AutopilotOutboxEvent,
  AutopilotStore,
} from '../../features/autopilot/application/ports.js';
import type { AutopilotSession } from '../../features/autopilot/domain/autopilot-session.js';
import { parsePersistedSupervisedLifecycle } from '../../features/autopilot/domain/supervised-lifecycle.js';

export class SqliteAutopilotStore implements AutopilotStore {
  constructor(private readonly db: DatabaseSync) {}
  find(sessionId: string): AutopilotSession | null {
    const row = this.db
      .prepare('SELECT * FROM autopilot_sessions WHERE session_id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const lifecycle = parseLifecycle(row.lifecycle_json);
    if (
      !['disabled', 'monitoring', 'backoff', 'attentionRequired', 'completed'].includes(
        String(row.state),
      ) ||
      ![
        'manualDisabled',
        'planRequired',
        'planComplete',
        'sessionUnavailable',
        'attentionRequired',
        'noPlanProgress',
        'reconcileFailed',
        'startUnavailable',
        'actionRateExceeded',
        'planRemoved',
        'planReplaced',
        'sessionEnded',
        'null',
      ].includes(String(row.stop_reason)) ||
      !Number.isSafeInteger(Number(row.generation)) ||
      Number(row.generation) < 0 ||
      !Number.isSafeInteger(Number(row.no_progress_count)) ||
      Number(row.no_progress_count) < 0 ||
      ![0, 1].includes(Number(row.requested_enabled)) ||
      lifecycle === null
    )
      return null;
    return {
      sessionId: String(row.session_id),
      state: row.state as AutopilotSession['state'],
      requestedEnabled: Number(row.requested_enabled) === 1,
      planIdentity: row.plan_identity === null ? null : String(row.plan_identity),
      planFingerprint: row.plan_fingerprint === null ? null : String(row.plan_fingerprint),
      generation: Number(row.generation),
      consecutiveNoProgress: Number(row.no_progress_count),
      nextEvaluationAt: row.next_evaluation_at === null ? null : String(row.next_evaluation_at),
      lastControlId: row.last_control_id === null ? null : String(row.last_control_id),
      stopReason: row.stop_reason as AutopilotSession['stopReason'],
      ...lifecycle,
      updatedAt: String(row.updated_at),
    };
  }
  save(state: AutopilotSession): void {
    this.db
      .prepare(
        'INSERT INTO autopilot_sessions (session_id,state,requested_enabled,plan_identity,plan_fingerprint,generation,no_progress_count,next_evaluation_at,last_control_id,stop_reason,lifecycle_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET state=excluded.state,requested_enabled=excluded.requested_enabled,plan_identity=excluded.plan_identity,plan_fingerprint=excluded.plan_fingerprint,generation=excluded.generation,no_progress_count=excluded.no_progress_count,next_evaluation_at=excluded.next_evaluation_at,last_control_id=excluded.last_control_id,stop_reason=excluded.stop_reason,lifecycle_json=excluded.lifecycle_json,updated_at=excluded.updated_at',
      )
      .run(
        state.sessionId,
        state.state,
        state.requestedEnabled ? 1 : 0,
        state.planIdentity,
        state.planFingerprint,
        state.generation,
        state.consecutiveNoProgress,
        state.nextEvaluationAt,
        state.lastControlId,
        state.stopReason,
        state.executor || state.blocking || state.checkpoints
          ? JSON.stringify({
              executor: state.executor,
              blocking: state.blocking,
              checkpoints: state.checkpoints,
            })
          : null,
        state.updatedAt,
      );
  }
  findControl(sessionId: string, controlId: string): AutopilotControl | null {
    const row = this.db
      .prepare('SELECT * FROM autopilot_controls WHERE session_id = ? AND control_id = ?')
      .get(sessionId, controlId) as Record<string, unknown> | undefined;
    if (
      !row ||
      !['scheduled', 'issued', 'started', 'failed', 'cancelled'].includes(String(row.status))
    )
      return null;
    const failureCode = row.failure_code === null ? null : String(row.failure_code);
    if (failureCode !== null && !['START_FAILED', 'START_UNAVAILABLE'].includes(failureCode))
      return null;
    return {
      sessionId: String(row.session_id),
      controlId: String(row.control_id),
      status: row.status as AutopilotControl['status'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      failureCode: failureCode as AutopilotControl['failureCode'],
      turnId: row.turn_id === null ? null : String(row.turn_id),
    };
  }
  saveControl(control: AutopilotControl): void {
    this.db
      .prepare(
        "INSERT INTO autopilot_controls (session_id,control_id,status,created_at,updated_at,failure_code,turn_id) VALUES (?,?,?,?,?,?,?) ON CONFLICT(session_id,control_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,failure_code=excluded.failure_code,turn_id=COALESCE(excluded.turn_id,autopilot_controls.turn_id) WHERE autopilot_controls.status = excluded.status OR (autopilot_controls.status = 'scheduled' AND excluded.status IN ('issued','cancelled')) OR (autopilot_controls.status = 'issued' AND excluded.status IN ('started','failed'))",
      )
      .run(
        control.sessionId,
        control.controlId,
        control.status,
        control.createdAt,
        control.updatedAt,
        control.failureCode,
        control.turnId ?? null,
      );
  }
  commit(
    input: Readonly<{
      state?: AutopilotSession;
      control?: AutopilotControl;
      events: readonly AutopilotAuditEvent[];
    }>,
  ): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (input.state) this.save(input.state);
      if (input.control) this.saveControl(input.control);
      this.appendOutbox(input.events);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  claimControlIssued(
    sessionId: string,
    controlId: string,
    updatedAt: string,
    state?: AutopilotSession,
    events: readonly AutopilotAuditEvent[] = [],
  ): AutopilotControl | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db
        .prepare(
          "UPDATE autopilot_controls SET status = 'issued', updated_at = ? WHERE session_id = ? AND control_id = ? AND status = 'scheduled'",
        )
        .run(updatedAt, sessionId, controlId);
      if (result.changes !== 1) {
        this.db.exec('ROLLBACK');
        return null;
      }
      const control = this.findControl(sessionId, controlId);
      if (!control) throw new Error('AUTOPILOT_CONTROL_MISSING_AFTER_CLAIM');
      if (state) this.save(state);
      this.appendOutbox(events);
      this.db.exec('COMMIT');
      return control;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  drainOutbox(sessionId: string): readonly AutopilotOutboxEvent[] {
    return (
      this.db
        .prepare(
          'SELECT id,session_id,type,payload_json,occurred_at FROM autopilot_outbox WHERE session_id = ? ORDER BY id',
        )
        .all(sessionId) as Array<{
        id: number;
        session_id: string;
        type: string;
        payload_json: string;
        occurred_at: string;
      }>
    ).map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      type: row.type,
      payload: JSON.parse(row.payload_json),
      occurredAt: row.occurred_at,
    }));
  }
  acknowledgeOutbox(id: number): void {
    this.db.prepare('DELETE FROM autopilot_outbox WHERE id = ?').run(id);
  }
  private appendOutbox(events: readonly AutopilotAuditEvent[]): void {
    const statement = this.db.prepare(
      'INSERT INTO autopilot_outbox (session_id,type,payload_json,occurred_at) VALUES (?,?,?,?)',
    );
    for (const event of events)
      statement.run(event.sessionId, event.type, JSON.stringify(event.payload), event.occurredAt);
  }
  acceptedControlTurns(sessionId: string): ReadonlyMap<string, string> {
    return new Map(
      (
        this.db
          .prepare(
            "SELECT turn_id,control_id FROM autopilot_controls WHERE session_id = ? AND status = 'started' AND turn_id IS NOT NULL",
          )
          .all(sessionId) as Array<{ turn_id: string; control_id: string }>
      ).map((row) => [row.turn_id, row.control_id]),
    );
  }
  automaticActionsSince(sessionId: string, since: string): number {
    const row = this.db
      .prepare(
        "SELECT count(*) AS count FROM autopilot_controls WHERE session_id = ? AND status IN ('issued','started','failed') AND updated_at >= ?",
      )
      .get(sessionId, since) as { count: number };
    return row.count;
  }
  controlIds(sessionId: string): ReadonlySet<string> {
    return new Set(
      (
        this.db
          .prepare('SELECT control_id FROM autopilot_controls WHERE session_id = ?')
          .all(sessionId) as Array<{ control_id: string }>
      ).map((row) => row.control_id),
    );
  }
  remove(sessionId: string): void {
    this.db.prepare('DELETE FROM autopilot_sessions WHERE session_id = ?').run(sessionId);
  }
}

function parseLifecycle(value: unknown): Pick<AutopilotSession, 'executor' | 'blocking'> | null {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'string' || value.length > 256_000) return null;
  try {
    return parsePersistedSupervisedLifecycle(JSON.parse(value)) ?? null;
  } catch {
    return null;
  }
}
