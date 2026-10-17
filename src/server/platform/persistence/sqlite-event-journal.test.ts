/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { SqliteEventJournal } from './sqlite-event-journal.js';

it('reads chat cuts without decoding unrelated payloads and bounds replay before decoding', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);
    db.prepare(
      "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
    ).run();
    const insert = db.prepare(
      'INSERT INTO session_events (session_id,sequence,occurred_at,type,payload_json) VALUES (?,?,?,?,?)',
    );
    // A JSON poison sentinel proves unrelated rows are never decoded by chat reads.
    for (let sequence = 1; sequence <= 1000; sequence++)
      insert.run('s', sequence, 't', 'agent.activity.updated', 'not-json');
    insert.run(
      's',
      1001,
      't',
      'activity.updated',
      JSON.stringify({ id: 'command', label: 'Command', detail: 'done' }),
    );
    insert.run(
      's',
      1002,
      't',
      'activity.updated',
      JSON.stringify({ id: 'later', label: 'Command', detail: 'later' }),
    );
    const journal = new SqliteEventJournal(db);
    expect(journal.currentSequence('s')).toBe(1002);
    expect(journal.currentSequence('missing')).toBe(0);
    expect(journal.activityHistory('s', 1001).map((event) => event.sequence)).toEqual([1001]);
    expect(journal.activityHistory('missing', 1002)).toEqual([]);
    expect(journal.replay('s', 0)).toEqual({ kind: 'resync', currentSequence: 1002 });
    expect(journal.replay('s', 1000)).toMatchObject({
      kind: 'replay',
      events: [{ sequence: 1001 }, { sequence: 1002 }],
    });
    expect(journal.replay('s', 1002)).toEqual({ kind: 'replay', events: [] });
    insert.run('s', 1003, 't', 'agent.activity.updated', 'x'.repeat(512 * 1024 + 1));
    expect(journal.replay('s', 1002)).toEqual({ kind: 'resync', currentSequence: 1003 });
    db.prepare('DELETE FROM session_events WHERE session_id = ? AND sequence <= ?').run('s', 1000);
    expect(journal.replay('s', 999)).toEqual({ kind: 'resync', currentSequence: 1003 });
  } finally {
    db.close();
  }
});

it('shows the owning turn explanation while final is pending, then prefers its final report', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);
    db.prepare(
      "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
    ).run();
    const journal = new SqliteEventJournal(db);
    const append = (turnId: string, phase: string, text: string, occurredAt: string) =>
      journal.append('s', 'agentMessageCompleted', { turnId, phase, text }, occurredAt);
    append('t', 'commentary', 'The L3 checkpoint step is missing.', '2026-10-10T12:00:00Z');
    append('other', 'final_answer', 'Unrelated', '2026-10-10T12:00:01Z');
    expect(journal.attentionReport('s', 't', '2026-10-10T12:00:01Z')).toBe(
      'The L3 checkpoint step is missing.',
    );
    append('t', 'commentary', 'Later unrelated commentary', '2026-10-10T12:00:02Z');
    expect(journal.attentionReport('s', 't', '2026-10-10T12:00:01Z')).toBe(
      'The L3 checkpoint step is missing.',
    );
    append(
      't',
      'final_answer',
      'Refresh the plan and retry the L3 checkpoint.',
      '2026-10-10T12:00:03Z',
    );
    expect(journal.attentionReport('s', 't', '2026-10-10T12:00:01Z')).toBe(
      'Refresh the plan and retry the L3 checkpoint.',
    );
  } finally {
    db.close();
  }
});
