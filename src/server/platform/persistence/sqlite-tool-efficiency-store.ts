/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  ToolEfficiencyState,
  ToolEfficiencyStore,
} from '../../features/agent-activity/tool-efficiency-projection.js';

/** Separate from journal retention so reconnect and server restarts retain deduplication keys. */
export class SqliteToolEfficiencyStore implements ToolEfficiencyStore {
  constructor(private readonly db: DatabaseSync) {}
  load(sessionId: string): ToolEfficiencyState | null {
    const row = this.db
      .prepare('SELECT state_json FROM tool_efficiency WHERE session_id = ?')
      .get(sessionId) as { state_json: string } | undefined;
    return row ? (JSON.parse(row.state_json) as ToolEfficiencyState) : null;
  }
  save(sessionId: string, state: ToolEfficiencyState): void {
    this.db
      .prepare(
        'INSERT INTO tool_efficiency (session_id,state_json) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET state_json = excluded.state_json',
      )
      .run(sessionId, JSON.stringify(state));
  }
}
