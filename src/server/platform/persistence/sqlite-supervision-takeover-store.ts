/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  SupervisionTakeoverStore,
  TakeoverClaim,
  TakeoverRecovery,
  TakeoverRecoveryState,
} from '../../features/autopilot/application/takeover-supervision.js';
import type { AutopilotSession } from '../../features/autopilot/domain/autopilot-session.js';
import type { AutopilotAuditEvent } from '../../features/autopilot/application/ports.js';
import type { SqliteAutopilotStore } from './sqlite-autopilot-store.js';
import { parsePersistedSupervisedLifecycle } from '../../features/autopilot/domain/supervised-lifecycle.js';

/** A durable plan-scoped reservation also fences a superseded supervisor after relay restart. */
export class SqliteSupervisionTakeoverStore implements SupervisionTakeoverStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly autopilot: SqliteAutopilotStore,
  ) {}
  owner(planIdentity: string): TakeoverClaim | null {
    const row = this.db
      .prepare(
        "SELECT session_id,epoch,phase FROM org_plan_takeovers WHERE plan_identity=? AND phase!='released'",
      )
      .get(planIdentity) as
      { session_id: string; epoch: number; phase: 'stopping' | 'ready' } | undefined;
    return row
      ? { planIdentity, sessionId: row.session_id, epoch: row.epoch, phase: row.phase }
      : null;
  }
  /** Keep the epoch tombstone and retired-writer fences after confirmed runtime release. */
  releaseSession(sessionId: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.autopilot.find(sessionId);
      const session = this.db
        .prepare('SELECT workspace_path FROM relay_sessions WHERE id=?')
        .get(sessionId) as { workspace_path: string } | undefined;
      if (state?.planIdentity && session) {
        const recovery: TakeoverRecoveryState = {
          sessionId,
          updatedAt: state.updatedAt,
          executor: state.executor,
          checkpoints: state.checkpoints,
        };
        this.db
          .prepare(
            'INSERT INTO org_plan_supervision_recovery (plan_identity,session_id,workspace_path,state_json) VALUES (?,?,?,?) ON CONFLICT(plan_identity,session_id) DO UPDATE SET workspace_path=excluded.workspace_path,state_json=excluded.state_json',
          )
          .run(state.planIdentity, sessionId, session.workspace_path, JSON.stringify(recovery));
      }
      this.db
        .prepare(
          "UPDATE org_plan_takeovers SET phase='released',epoch=epoch+1 WHERE session_id=? AND phase!='released'",
        )
        .run(sessionId);
      this.db
        .prepare('UPDATE org_plan_retired_supervisors SET stopped=1 WHERE session_id=?')
        .run(sessionId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** Missing roster rows are recoverable only with durable stop evidence. */
  recovery(
    planIdentity: string,
    workspacePath: string,
    knownSessionIds: readonly string[],
  ): TakeoverRecovery {
    const retained = this.db
      .prepare('SELECT session_id,epoch,phase FROM org_plan_takeovers WHERE plan_identity=?')
      .get(planIdentity) as { session_id: string; epoch: number; phase: string } | undefined;
    const retired = this.db
      .prepare('SELECT session_id,stopped FROM org_plan_retired_supervisors WHERE plan_identity=?')
      .all(planIdentity) as { session_id: string; stopped: number }[];
    const snapshots = this.db
      .prepare(
        'SELECT session_id,workspace_path,state_json FROM org_plan_supervision_recovery WHERE plan_identity=?',
      )
      .all(planIdentity) as { session_id: string; workspace_path: string; state_json: string }[];
    const ids = new Set([
      ...(retained ? [retained.session_id] : []),
      ...retired.map((row) => row.session_id),
      ...snapshots.map((row) => row.session_id),
    ]);
    const sessionIds: string[] = [];
    const states: TakeoverRecoveryState[] = [];
    let verified = knownSessionIds.length > 1 || [...ids].some((id) => id !== knownSessionIds[0]);
    for (const id of ids) {
      if (knownSessionIds.includes(id)) continue;
      const session = this.db
        .prepare(
          'SELECT workspace_path,thread_id,state,desired_state FROM relay_sessions WHERE id=?',
        )
        .get(id) as
        | { workspace_path: string; thread_id: string | null; state: string; desired_state: string }
        | undefined;
      const snapshot = snapshots.find((row) => row.session_id === id);
      const forgotten = Boolean(
        this.db
          .prepare(
            "SELECT 1 FROM session_forget_operations WHERE session_id=? AND phase='completed'",
          )
          .get(id),
      );
      const stopped =
        (retained?.session_id === id && retained.phase === 'released') ||
        retired.some((row) => row.session_id === id && row.stopped === 1) ||
        Boolean(snapshot) ||
        forgotten;
      if (
        !stopped ||
        (snapshot && snapshot.workspace_path !== workspacePath) ||
        (session &&
          (session.workspace_path !== workspacePath ||
            session.desired_state !== 'stopped' ||
            !['stopped', 'released'].includes(session.state) ||
            !this.db
              .prepare(
                'SELECT 1 FROM session_runtime_releases WHERE session_id=? AND workspace_path=? AND thread_id=?',
              )
              .get(id, workspacePath, session.thread_id)))
      ) {
        verified = false;
        continue;
      }
      sessionIds.push(id);
      if (snapshot) {
        let value: TakeoverRecoveryState;
        try {
          value = JSON.parse(snapshot.state_json) as TakeoverRecoveryState;
        } catch {
          verified = false;
          continue;
        }
        const lifecycle = parsePersistedSupervisedLifecycle(value);
        if (!lifecycle || value.sessionId !== id || typeof value.updatedAt !== 'string') {
          verified = false;
          continue;
        }
        states.push({
          sessionId: id,
          updatedAt: value.updatedAt,
          executor: lifecycle.executor,
          checkpoints: lifecycle.checkpoints,
        });
      }
    }
    return { epoch: retained?.epoch ?? null, verified, sessionIds, states };
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
  claim(
    planIdentity: string,
    sessionId: string,
    expectedEpoch?: number | null,
  ): TakeoverClaim | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.owner(planIdentity);
      const retained = this.db
        .prepare('SELECT epoch FROM org_plan_takeovers WHERE plan_identity=?')
        .get(planIdentity) as { epoch: number } | undefined;
      if (expectedEpoch !== undefined && (retained?.epoch ?? null) !== expectedEpoch) {
        this.db.exec('ROLLBACK');
        return null;
      }
      if (previous?.phase === 'stopping' && previous.sessionId !== sessionId) {
        const owner = this.db
          .prepare('SELECT state,active_turn_id FROM relay_sessions WHERE id=?')
          .get(previous.sessionId) as { state: string; active_turn_id: string | null } | undefined;
        if (owner && (owner.state === 'turnActive' || owner.active_turn_id)) {
          this.db.exec('ROLLBACK');
          return null;
        }
      }
      const epoch = previous?.sessionId === sessionId ? previous.epoch : (retained?.epoch ?? 0) + 1;
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
