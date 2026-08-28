/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { DatabaseSync } from 'node:sqlite';

const schema = `CREATE TABLE IF NOT EXISTS relay_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workspace_path TEXT NOT NULL, profile TEXT NOT NULL, model TEXT, branch TEXT, sandbox TEXT, approval_policy TEXT, thread_id TEXT, state TEXT NOT NULL, desired_state TEXT NOT NULL, active_turn_id TEXT, protocol_version TEXT, failure_count INTEGER NOT NULL DEFAULT 0, effective_skill_selection_json TEXT, last_org_plan_json TEXT, next_sequence INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pending_interactions (session_id TEXT NOT NULL REFERENCES relay_sessions(id) ON DELETE CASCADE, request_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, turn_id TEXT, requested_at TEXT, resolved_at TEXT, outcome TEXT, operation_key TEXT, resolution_state TEXT NOT NULL DEFAULT 'active', PRIMARY KEY (session_id, request_id)); CREATE TABLE IF NOT EXISTS session_events (session_id TEXT NOT NULL REFERENCES relay_sessions(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, occurred_at TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, autopilot_outbox_id INTEGER, PRIMARY KEY (session_id, sequence), UNIQUE(session_id, autopilot_outbox_id)); CREATE TABLE IF NOT EXISTS idempotency_results (scope TEXT NOT NULL, key TEXT NOT NULL, status_code INTEGER NOT NULL, body_json TEXT NOT NULL, PRIMARY KEY (scope, key)); CREATE TABLE IF NOT EXISTS autopilot_sessions (session_id TEXT PRIMARY KEY REFERENCES relay_sessions(id) ON DELETE CASCADE, state TEXT NOT NULL, requested_enabled INTEGER NOT NULL, plan_identity TEXT, plan_fingerprint TEXT, generation INTEGER NOT NULL, no_progress_count INTEGER NOT NULL, next_evaluation_at TEXT, last_control_id TEXT, stop_reason TEXT, lifecycle_json TEXT, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS autopilot_controls (session_id TEXT NOT NULL REFERENCES relay_sessions(id) ON DELETE CASCADE, control_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, failure_code TEXT, turn_id TEXT, PRIMARY KEY (session_id, control_id)); CREATE TABLE IF NOT EXISTS autopilot_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES relay_sessions(id) ON DELETE CASCADE, type TEXT NOT NULL, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL);`;
export function migrate(database: DatabaseSync): void {
  database.exec(schema);
  database.exec(
    "CREATE INDEX IF NOT EXISTS session_events_autopilot_audit_tail_v3 ON session_events(session_id, type, sequence DESC) WHERE type IN ('autopilot.continuation-scheduled','autopilot.control-issued','autopilot.turn-started','autopilot.turn-failed','autopilot.progress-reset','autopilot.final-rejected','autopilot.executor-resumed','autopilot.process-monitoring','autopilot.process-result-consumed','autopilot.process-terminated','autopilot.updated','org-plan.attention-required','org-plan.attention-resolved')",
  );
  const columns = database.prepare('PRAGMA table_info(relay_sessions)').all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'effective_skill_selection_json'))
    database.exec('ALTER TABLE relay_sessions ADD COLUMN effective_skill_selection_json TEXT');
  if (!columns.some((column) => column.name === 'last_org_plan_json'))
    database.exec('ALTER TABLE relay_sessions ADD COLUMN last_org_plan_json TEXT');
  if (!columns.some((column) => column.name === 'model'))
    database.exec('ALTER TABLE relay_sessions ADD COLUMN model TEXT');
  if (!columns.some((column) => column.name === 'branch'))
    database.exec('ALTER TABLE relay_sessions ADD COLUMN branch TEXT');
  if (!columns.some((column) => column.name === 'attention_tool_capability'))
    database.exec('ALTER TABLE relay_sessions ADD COLUMN attention_tool_capability TEXT');
  if (!columns.some((column) => column.name === 'sandbox'))
    database.exec('ALTER TABLE relay_sessions ADD COLUMN sandbox TEXT');
  if (!columns.some((column) => column.name === 'approval_policy'))
    database.exec('ALTER TABLE relay_sessions ADD COLUMN approval_policy TEXT');
  const autopilotColumns = database
    .prepare('PRAGMA table_info(autopilot_sessions)')
    .all() as Array<{ name: string }>;
  if (!autopilotColumns.some((column) => column.name === 'lifecycle_json'))
    database.exec('ALTER TABLE autopilot_sessions ADD COLUMN lifecycle_json TEXT');
  const interactionColumns = database
    .prepare('PRAGMA table_info(pending_interactions)')
    .all() as Array<{ name: string }>;
  if (!interactionColumns.some((column) => column.name === 'turn_id'))
    database.exec('ALTER TABLE pending_interactions ADD COLUMN turn_id TEXT');
  if (!interactionColumns.some((column) => column.name === 'requested_at'))
    database.exec('ALTER TABLE pending_interactions ADD COLUMN requested_at TEXT');
  if (!interactionColumns.some((column) => column.name === 'outcome'))
    database.exec('ALTER TABLE pending_interactions ADD COLUMN outcome TEXT');
  if (!interactionColumns.some((column) => column.name === 'operation_key'))
    database.exec('ALTER TABLE pending_interactions ADD COLUMN operation_key TEXT');
  if (!interactionColumns.some((column) => column.name === 'resolution_state'))
    database.exec(
      "ALTER TABLE pending_interactions ADD COLUMN resolution_state TEXT NOT NULL DEFAULT 'active'",
    );
  const eventColumns = database.prepare('PRAGMA table_info(session_events)').all() as Array<{
    name: string;
  }>;
  if (!eventColumns.some((column) => column.name === 'autopilot_outbox_id')) {
    database.exec('ALTER TABLE session_events ADD COLUMN autopilot_outbox_id INTEGER');
    database.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS session_events_autopilot_outbox ON session_events(session_id, autopilot_outbox_id)',
    );
  }
  const controlColumns = database.prepare('PRAGMA table_info(autopilot_controls)').all() as Array<{
    name: string;
  }>;
  if (!controlColumns.some((column) => column.name === 'turn_id'))
    database.exec('ALTER TABLE autopilot_controls ADD COLUMN turn_id TEXT');
}
