import type { DatabaseSync } from 'node:sqlite';

import type { RelaySessionSnapshot } from '../../features/sessions/model/relay-session.js';

type Row = {
  id: string;
  workspace_id: string;
  workspace_path: string;
  profile: string;
  thread_id: string | null;
  state: RelaySessionSnapshot['state'];
  desired_state: RelaySessionSnapshot['desiredState'];
  active_turn_id: string | null;
  protocol_version: string | null;
  failure_count: number;
  created_at: string;
  updated_at: string;
};

export class SqliteSessionRepository {
  constructor(private readonly db: DatabaseSync) {}
  save(session: RelaySessionSnapshot): void {
    this.db
      .prepare(
        'INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,thread_id,state,desired_state,active_turn_id,protocol_version,failure_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,workspace_path=excluded.workspace_path,profile=excluded.profile,thread_id=excluded.thread_id,state=excluded.state,desired_state=excluded.desired_state,active_turn_id=excluded.active_turn_id,protocol_version=excluded.protocol_version,failure_count=excluded.failure_count,updated_at=excluded.updated_at',
      )
      .run(
        session.id,
        session.workspaceId,
        session.workspacePath,
        session.profile,
        session.threadId,
        session.state,
        session.desiredState,
        session.activeTurnId,
        session.protocolVersion,
        session.failureCount,
        session.createdAt,
        session.updatedAt,
      );
  }
  find(id: string): RelaySessionSnapshot | null {
    const row = this.db.prepare('SELECT * FROM relay_sessions WHERE id = ?').get(id) as
      Row | undefined;
    return row ? map(row) : null;
  }
  list(): RelaySessionSnapshot[] {
    return (
      this.db.prepare('SELECT * FROM relay_sessions ORDER BY updated_at DESC').all() as Row[]
    ).map(map);
  }
}
function map(row: Row): RelaySessionSnapshot {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspacePath: row.workspace_path,
    profile: row.profile,
    threadId: row.thread_id,
    state: row.state,
    desiredState: row.desired_state,
    activeTurnId: row.active_turn_id,
    protocolVersion: row.protocol_version,
    failureCount: row.failure_count,
    pendingInteractions: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
