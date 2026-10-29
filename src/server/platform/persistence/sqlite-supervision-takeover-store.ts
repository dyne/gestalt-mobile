/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  SupervisionTakeoverStore,
  TakeoverClaim,
} from '../../features/autopilot/application/takeover-supervision.js';
import type { AutopilotSession } from '../../features/autopilot/domain/autopilot-session.js';
import type { AutopilotAuditEvent } from '../../features/autopilot/application/ports.js';
import type { SqliteAutopilotStore } from './sqlite-autopilot-store.js';

/** A durable plan-scoped reservation also fences a superseded supervisor after relay restart. */
export class SqliteSupervisionTakeoverStore implements SupervisionTakeoverStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly autopilot: SqliteAutopilotStore,
  ) {}
  owner(planIdentity: string): TakeoverClaim | null {
    const row = this.db
      .prepare('SELECT session_id,epoch,phase FROM org_plan_takeovers WHERE plan_identity=?')
      .get(planIdentity) as
      { session_id: string; epoch: number; phase: 'stopping' | 'ready' } | undefined;
    return row
      ? { planIdentity, sessionId: row.session_id, epoch: row.epoch, phase: row.phase }
      : null;
  }
  retired(planIdentity: string, sessionId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM org_plan_retired_supervisors WHERE plan_identity=? AND session_id=?',
        )
        .get(planIdentity, sessionId),
    );
  }
  stopped(planIdentity: string, sessionId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM org_plan_retired_supervisors WHERE plan_identity=? AND session_id=? AND stopped=1',
        )
        .get(planIdentity, sessionId),
    );
  }
  markStopped(claim: TakeoverClaim, sessionId: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE org_plan_retired_supervisors SET stopped=1 WHERE plan_identity=? AND session_id=? AND EXISTS (SELECT 1 FROM org_plan_takeovers WHERE plan_identity=? AND session_id=? AND epoch=? AND phase='stopping')",
        )
        .run(claim.planIdentity, sessionId, claim.planIdentity, claim.sessionId, claim.epoch)
        .changes === 1
    );
  }
  retire(claim: TakeoverClaim, sessionIds: readonly string[]): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.owner(claim.planIdentity);
      if (
        !current ||
        current.sessionId !== claim.sessionId ||
        current.epoch !== claim.epoch ||
        current.phase !== 'stopping'
      ) {
        this.db.exec('ROLLBACK');
        return false;
      }
      for (const sessionId of sessionIds)
        this.db
          .prepare(
            'INSERT OR IGNORE INTO org_plan_retired_supervisors (plan_identity,session_id) VALUES (?,?)',
          )
          .run(claim.planIdentity, sessionId);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  claim(planIdentity: string, sessionId: string): TakeoverClaim | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.owner(planIdentity);
      if (previous?.phase === 'stopping' && previous.sessionId !== sessionId) {
        const owner = this.db
          .prepare('SELECT state,active_turn_id FROM relay_sessions WHERE id=?')
          .get(previous.sessionId) as { state: string; active_turn_id: string | null } | undefined;
        if (owner && (owner.state === 'turnActive' || owner.active_turn_id)) {
          this.db.exec('ROLLBACK');
          return null;
        }
      }
      const epoch = previous?.sessionId === sessionId ? previous.epoch : (previous?.epoch ?? 0) + 1;
      const phase = previous?.sessionId === sessionId ? previous.phase : 'stopping';
      this.db
        .prepare(
          'INSERT INTO org_plan_takeovers (plan_identity,session_id,epoch,phase) VALUES (?,?,?,?) ON CONFLICT(plan_identity) DO UPDATE SET session_id=excluded.session_id,epoch=excluded.epoch,phase=excluded.phase',
        )
        .run(planIdentity, sessionId, epoch, phase);
      this.db.exec('COMMIT');
      return { planIdentity, sessionId, epoch, phase };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  complete(
    claim: TakeoverClaim,
    state: AutopilotSession,
    events: readonly AutopilotAuditEvent[],
    root: Readonly<{ threadId: string; turnId: string }>,
  ): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.owner(claim.planIdentity);
      const base = this.autopilot.find(state.sessionId);
      const session = this.db
        .prepare('SELECT thread_id,active_turn_id FROM relay_sessions WHERE id=?')
        .get(state.sessionId) as { thread_id: string; active_turn_id: string } | undefined;
      if (
        !session ||
        session.thread_id !== root.threadId ||
        session.active_turn_id !== root.turnId ||
        !current ||
        current.sessionId !== claim.sessionId ||
        current.epoch !== claim.epoch ||
        current.phase !== 'stopping' ||
        (base?.generation ?? 0) !== state.generation - 1
      ) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.autopilot.save(state);
      for (const e of events)
        this.db
          .prepare(
            'INSERT INTO autopilot_outbox (session_id,type,payload_json,occurred_at) VALUES (?,?,?,?)',
          )
          .run(e.sessionId, e.type, JSON.stringify(e.payload), e.occurredAt);
      this.db
        .prepare("UPDATE org_plan_takeovers SET phase='ready' WHERE plan_identity=?")
        .run(claim.planIdentity);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
