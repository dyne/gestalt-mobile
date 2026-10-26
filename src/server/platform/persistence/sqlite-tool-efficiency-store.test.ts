/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { SqliteToolEfficiencyStore } from './sqlite-tool-efficiency-store.js';
import { ToolEfficiencyProjection } from '../../features/agent-activity/tool-efficiency-projection.js';
import { decodeToolEfficiencyFacts } from '../codex/tool-efficiency-facts.js';
import { SqliteEventJournal } from './sqlite-event-journal.js';

it('persists call replacement and deduplication independently of journal retention and replay', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    migrate(db);
    db.prepare(
      "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
    ).run();
    const journal = new SqliteEventJournal(db, 2);
    const projection = new ToolEfficiencyProjection(new SqliteToolEfficiencyStore(db));
    const observe = (phase: string) => {
      const fact = decodeToolEfficiencyFacts(
        's',
        '2026-10-26T18:50:00Z',
        {
          method: phase,
          params: {
            threadId: 'root',
            item: {
              id: 'call',
              type: 'commandExecution',
              status: 'completed',
              durationMs: 0,
              aggregatedOutput: '',
              command: 'secret',
            },
          },
        },
        { runtimeId: 'runtime', rootThreadId: 'root' },
      )[0];
      const snapshot = projection.observe(fact);
      if (snapshot)
        journal.append('s', 'tool.efficiency.updated', snapshot, '2026-10-26T18:50:00Z');
      return fact;
    };
    observe('item/started');
    const completed = observe('item/completed');
    const expected = projection.snapshot('s');
    const replay = journal.replay('s', 0);
    expect(replay).toMatchObject({
      kind: 'replay',
      events: [{ payload: { groups: [{ calls: 1, completedCalls: 0 }] } }, { payload: expected }],
    });
    const loaded = new ToolEfficiencyProjection(new SqliteToolEfficiencyStore(db));
    expect(loaded.snapshot('s')).toEqual(expected);
    expect(loaded.observe(completed)).toBeNull();
    for (let n = 0; n < 5; n++) journal.append('s', 'irrelevant', {}, '2026-10-26T18:50:00Z');
    expect(journal.replay('s', 0).kind).toBe('resync');
    expect(
      new ToolEfficiencyProjection(new SqliteToolEfficiencyStore(db)).observe(completed),
    ).toBeNull();
    expect(new ToolEfficiencyProjection(new SqliteToolEfficiencyStore(db)).snapshot('s')).toEqual(
      expected,
    );
    expect(
      JSON.stringify(db.prepare('SELECT state_json FROM tool_efficiency').all()),
    ).not.toContain('secret');
    db.prepare('DELETE FROM relay_sessions WHERE id = ?').run('s');
    expect(db.prepare('SELECT * FROM tool_efficiency').all()).toEqual([]);
  } finally {
    db.close();
  }
});
