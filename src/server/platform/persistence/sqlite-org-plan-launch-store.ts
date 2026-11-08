/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  OrgPlanLaunchPhase,
  OrgPlanLaunchRecord,
  OrgPlanLaunchStore,
  OrgPlanPublicationSessions,
} from '../../features/plans/application/org-plan-launch-store.js';
import type { RelaySessionSnapshot } from '../../features/sessions/model/relay-session.js';

export class SqliteOrgPlanLaunchStore implements OrgPlanLaunchStore {
  readonly #operations = new Map<string, Promise<void>>();
  constructor(private readonly db: DatabaseSync) {}
  find(launchId: string): OrgPlanLaunchRecord | null {
    return decode(
      this.db.prepare('SELECT record_json FROM org_plan_launches WHERE launch_id=?').get(launchId),
    );
  }
  owner(canonicalPath: string): OrgPlanLaunchRecord | null {
    return decode(
      this.db
        .prepare('SELECT record_json FROM org_plan_launches WHERE canonical_path=?')
        .get(canonicalPath),
    );
  }
  forSession(sessionId: string): OrgPlanLaunchRecord | null {
    return decode(
      this.db
        .prepare('SELECT record_json FROM org_plan_launches WHERE session_id=?')
        .get(sessionId),
    );
  }
  reserve(record: OrgPlanLaunchRecord): ReturnType<OrgPlanLaunchStore['reserve']> {
    const inserted = this.db
      .prepare(
        'INSERT OR IGNORE INTO org_plan_launches (launch_id,canonical_path,session_id,phase,record_json) VALUES (?,?,?,?,?)',
      )
      .run(
        record.launchId,
        record.canonicalPath,
        record.sessionId,
        record.phase,
        JSON.stringify(record),
      );
    if (inserted.changes === 1) return { kind: 'reserved', record };
    const existing = this.find(record.launchId);
    if (existing) return { kind: 'existing', record: existing };
    const owner = this.owner(record.canonicalPath);
    if (!owner) throw new Error('ORG_PLAN_RESERVATION_CONFLICT');
    return { kind: 'owned', record: owner };
  }
  save(record: OrgPlanLaunchRecord, expected: OrgPlanLaunchPhase): boolean {
    return (
      this.db
        .prepare(
          "UPDATE org_plan_launches SET phase=?,record_json=? WHERE launch_id=? AND session_id=? AND phase=? AND coalesce(json_extract(record_json,'$.publicationRevision'),0)=?",
        )
        .run(
          record.phase,
          JSON.stringify(record),
          record.launchId,
          record.sessionId,
          expected,
          record.publicationRevision ?? 0,
        ).changes === 1
    );
  }
  releaseOwner(record: OrgPlanLaunchRecord): void {
    this.db
      .prepare(
        'UPDATE org_plan_launches SET canonical_path=NULL WHERE launch_id=? AND session_id=? AND canonical_path=?',
      )
      .run(record.launchId, record.sessionId, record.canonicalPath);
  }
  acquireOwner(record: OrgPlanLaunchRecord): boolean {
    this.db
      .prepare(
        'UPDATE OR IGNORE org_plan_launches SET canonical_path=? WHERE launch_id=? AND session_id=? AND canonical_path IS NULL',
      )
      .run(record.canonicalPath, record.launchId, record.sessionId);
    return this.owner(record.canonicalPath)?.launchId === record.launchId;
  }
  publishSession(
    record: OrgPlanLaunchRecord,
    candidate: RelaySessionSnapshot,
    sessions: OrgPlanPublicationSessions,
  ): { created: boolean; session: RelaySessionSnapshot } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.find(record.launchId);
      if (!current || current.sessionId !== candidate.id || record.sessionId !== candidate.id)
        throw new Error('ORG_PLAN_PUBLICATION_FENCED');
      const existing = sessions.find(record.sessionId);
      if (existing) {
        this.db.exec('COMMIT');
        return { created: false, session: existing };
      }
      if (
        current.phase !== 'creating' ||
        (current.publicationRevision ?? 0) !== (record.publicationRevision ?? 0) ||
        this.owner(record.canonicalPath)?.launchId !== record.launchId
      )
        throw new Error('ORG_PLAN_PUBLICATION_FENCED');
      sessions.save(candidate);
      if (
        !sessions.find(candidate.id) ||
        !this.save({ ...current, phase: 'session', notPersisted: false }, 'creating')
      )
        throw new Error('ORG_PLAN_PUBLICATION_FENCED');
      this.db.exec('COMMIT');
      return { created: true, session: candidate };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  revokePublication(
    record: OrgPlanLaunchRecord,
    sessions: Pick<OrgPlanPublicationSessions, 'find'>,
  ): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.find(record.launchId);
      if (
        !current ||
        current.sessionId !== record.sessionId ||
        !['reserved', 'creating'].includes(current.phase) ||
        (current.publicationRevision ?? 0) !== (record.publicationRevision ?? 0) ||
        sessions.find(record.sessionId)
      ) {
        this.db.exec('COMMIT');
        return false;
      }
      const revoked = {
        ...current,
        phase: 'reserved' as const,
        notPersisted: true,
        publicationRevision: (current.publicationRevision ?? 0) + 1,
      };
      const changed =
        this.db
          .prepare(
            "UPDATE org_plan_launches SET phase='reserved',canonical_path=NULL,record_json=? WHERE launch_id=? AND session_id=? AND phase=? AND coalesce(json_extract(record_json,'$.publicationRevision'),0)=?",
          )
          .run(
            JSON.stringify(revoked),
            record.launchId,
            record.sessionId,
            current.phase,
            current.publicationRevision ?? 0,
          ).changes === 1;
      this.db.exec('COMMIT');
      return changed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async run<T>(launchId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#operations.get(launchId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#operations.set(launchId, current);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.#operations.get(launchId) === current) this.#operations.delete(launchId);
    }
  }
}

function decode(row: unknown): OrgPlanLaunchRecord | null {
  return row
    ? (JSON.parse((row as { record_json: string }).record_json) as OrgPlanLaunchRecord)
    : null;
}
