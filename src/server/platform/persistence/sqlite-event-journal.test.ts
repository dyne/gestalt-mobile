/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { SqliteEventJournal } from './sqlite-event-journal.js';

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
