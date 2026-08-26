/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { DatabaseSync } from 'node:sqlite';

import {
  createEffectiveSkillSelection,
  createSessionExecutionPolicy,
  type RelaySessionSnapshot,
} from '../../features/sessions/model/relay-session.js';

type Row = {
  id: string;
  workspace_id: string;
  workspace_path: string;
  profile: string;
  model: string | null;
  branch: string | null;
  sandbox: string | null;
  approval_policy: string | null;
  thread_id: string | null;
  state: RelaySessionSnapshot['state'];
  desired_state: RelaySessionSnapshot['desiredState'];
  active_turn_id: string | null;
  protocol_version: string | null;
  attention_tool_capability: string | null;
  failure_count: number;
  effective_skill_selection_json: string | null;
  last_org_plan_json: string | null;
  created_at: string;
  updated_at: string;
};

export class SqliteSessionRepository {
  constructor(private readonly db: DatabaseSync) {}
  save(session: RelaySessionSnapshot): void {
    this.db
      .prepare(
        'INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,model,branch,sandbox,approval_policy,thread_id,state,desired_state,active_turn_id,protocol_version,attention_tool_capability,failure_count,effective_skill_selection_json,last_org_plan_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,workspace_path=excluded.workspace_path,profile=excluded.profile,model=excluded.model,branch=excluded.branch,sandbox=excluded.sandbox,approval_policy=excluded.approval_policy,thread_id=excluded.thread_id,state=excluded.state,desired_state=excluded.desired_state,active_turn_id=excluded.active_turn_id,protocol_version=excluded.protocol_version,attention_tool_capability=excluded.attention_tool_capability,failure_count=excluded.failure_count,effective_skill_selection_json=excluded.effective_skill_selection_json,last_org_plan_json=excluded.last_org_plan_json,updated_at=excluded.updated_at',
      )
      .run(
        session.id,
        session.workspaceId,
        session.workspacePath,
        session.profile,
        session.model ?? null,
        session.branch ?? null,
        session.executionPolicy?.sandbox ?? null,
        session.executionPolicy?.approvalPolicy ?? null,
        session.threadId,
        session.state,
        session.desiredState,
        session.activeTurnId,
        session.protocolVersion,
        session.attentionToolCapability ?? null,
        session.failureCount,
        session.effectiveSkillSelection === undefined
          ? null
          : JSON.stringify(session.effectiveSkillSelection),
        session.lastOrgPlan === undefined ? null : JSON.stringify(session.lastOrgPlan),
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
  remove(id: string): void {
    this.db.prepare('DELETE FROM relay_sessions WHERE id = ?').run(id);
  }
}
function map(row: Row): RelaySessionSnapshot {
  const sandbox = row.sandbox ?? null;
  const approvalPolicy = row.approval_policy ?? null;
  if (approvalPolicy === null && sandbox !== null)
    throw new Error('SESSION_EXECUTION_POLICY_INVALID');
  const executionPolicy =
    approvalPolicy === null
      ? undefined
      : createSessionExecutionPolicy({ sandbox: sandbox ?? undefined, approvalPolicy });
  const effectiveSkillSelection = row.effective_skill_selection_json
    ? createEffectiveSkillSelection(
        JSON.parse(row.effective_skill_selection_json) as {
          selectedProfileName?: string;
          skills: Array<{ name: string; path: string; enabled: boolean }>;
        },
      )
    : undefined;
  const lastOrgPlan = row.last_org_plan_json
    ? (JSON.parse(row.last_org_plan_json) as RelaySessionSnapshot['lastOrgPlan'])
    : undefined;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspacePath: row.workspace_path,
    profile: row.profile,
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.branch === null ? {} : { branch: row.branch }),
    ...(executionPolicy === undefined ? {} : { executionPolicy }),
    threadId: row.thread_id,
    state: row.state,
    desiredState: row.desired_state,
    activeTurnId: row.active_turn_id,
    protocolVersion: row.protocol_version,
    ...(row.attention_tool_capability === 'supported'
      ? { attentionToolCapability: 'supported' as const }
      : {}),
    failureCount: row.failure_count,
    ...(effectiveSkillSelection === undefined ? {} : { effectiveSkillSelection }),
    ...(lastOrgPlan === undefined ? {} : { lastOrgPlan }),
    pendingInteractions: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
