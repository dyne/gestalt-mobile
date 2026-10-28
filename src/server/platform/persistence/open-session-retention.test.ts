/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { SqliteEventJournal } from './sqlite-event-journal.js';

describe('open session event retention', () => {
  for (const state of ['starting', 'ready', 'turnActive', 'recovering', 'attentionRequired']) {
    it(`keeps the first event of a ${state} session beyond 48 hours`, () => {
      const db = new DatabaseSync(':memory:');
      migrate(db);
      db.prepare(
        "INSERT INTO relay_sessions(id,workspace_id,workspace_path,profile,state,desired_state,created_at,updated_at) VALUES ('open','w','/w','default',?,'active','t','t')",
      ).run(state);
      try {
        const journal = new SqliteEventJournal(db);
        journal.append('open', 'first', {}, '2026-10-01T00:00:00Z');
        journal.append('open', 'later', {}, '2026-10-04T00:00:00Z');
        expect(journal.since('open', 0).map((event) => event.type)).toEqual(['first', 'later']);
        const capped = new SqliteEventJournal(db, 1);
        capped.append('open', 'newest', {}, '2026-10-04T00:00:01Z');
        expect(journal.since('open', 0)).toHaveLength(3);
      } finally {
        db.close();
      }
    });
  }

  it('prunes closed sessions on subsequent traffic and protects a restored session', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.exec(
      "INSERT INTO relay_sessions(id,workspace_id,workspace_path,profile,state,desired_state,created_at,updated_at) VALUES ('open','w','/w','default','ready','active','t','t'), ('closed','w','/w','default','released','stopped','t','t')",
    );
    try {
      const journal = new SqliteEventJournal(db);
      journal.append('open', 'first', {}, '2026-10-01T00:00:00Z');
      journal.append('closed', 'first', {}, '2026-10-01T00:00:00Z');
      journal.append('open', 'later', {}, '2026-10-04T00:00:00Z');
      expect(journal.since('open', 0)).toHaveLength(2);
      expect(journal.since('closed', 0)).toHaveLength(0);
      journal.append('closed', 'restored-first', {}, '2026-10-04T00:00:00Z');
      db.exec("UPDATE relay_sessions SET state='ready',desired_state='active' WHERE id='closed'");
      const restartedJournal = new SqliteEventJournal(db);
      restartedJournal.append('open', 'later-again', {}, '2026-10-07T00:00:00Z');
      expect(restartedJournal.since('closed', 0).map((event) => event.type)).toEqual([
        'restored-first',
      ]);
    } finally {
      db.close();
    }
  });
});
