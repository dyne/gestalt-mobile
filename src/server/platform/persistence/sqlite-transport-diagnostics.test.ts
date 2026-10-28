/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect } from 'vitest';
import { migrate } from './migrate.js';
import {
  SqliteTransportDiagnostics,
  readTransportDiagnostics,
  transportLimit,
  transportRetentionMs,
} from './sqlite-transport-diagnostics.js';

describe('transport evidence', () => {
  it('caps closed-session storage, filters expired records and never appends replay events', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    for (const id of ['s', 'other'])
      db.prepare(
        "INSERT INTO relay_sessions(id, workspace_id, workspace_path, profile, state, desired_state, created_at, updated_at) VALUES (?, 'w', '/w', 'default', 'stopped', 'stopped', 'now', 'now')",
      ).run(id);
    const sink = new SqliteTransportDiagnostics(db);
    try {
      for (let i = 0; i < transportLimit + 3; i++)
        sink.record('s', { kind: 'history', durationMs: i }, 100);
      const trace = readTransportDiagnostics(db, 's', 100);
      expect(trace.records).toHaveLength(transportLimit);
      expect(trace.records[0]?.durationMs).toBe(3);
      expect(readTransportDiagnostics(db, 's', transportRetentionMs + 101).records).toEqual([]);
      sink.record('other', { kind: 'resync', durationMs: 1, after: 0 }, transportRetentionMs + 101);
      expect(db.prepare('SELECT COUNT(*) AS n FROM chat_transport_diagnostics').get()?.n).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM session_events').get()?.n).toBe(0);
    } finally {
      db.close();
    }
  });
  it('keeps open-session records beyond age and volume limits until closure', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.exec(
      "INSERT INTO relay_sessions(id,workspace_id,workspace_path,profile,state,desired_state,created_at,updated_at) VALUES ('open','w','/w','default','ready','active','t','t'), ('closed','w','/w','default','released','stopped','t','t')",
    );
    const sink = new SqliteTransportDiagnostics(db);
    try {
      for (let i = 0; i < transportLimit + 3; i++)
        sink.record('open', { kind: 'history', durationMs: i }, 100);
      sink.record('closed', { kind: 'history', durationMs: 1 }, 100);
      const later = transportRetentionMs + 101;
      sink.record('open', { kind: 'resync', durationMs: 1 }, later);
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM chat_transport_diagnostics WHERE session_id='open'")
          .get()?.n,
      ).toBe(transportLimit + 4);
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM chat_transport_diagnostics WHERE session_id='closed'")
          .get()?.n,
      ).toBe(0);
      expect(readTransportDiagnostics(db, 'open', later).records).toHaveLength(transportLimit);
      db.exec("UPDATE relay_sessions SET state='stopped',desired_state='stopped' WHERE id='open'");
      sink.record('closed', { kind: 'history', durationMs: 1 }, later);
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM chat_transport_diagnostics WHERE session_id='open'")
          .get()?.n,
      ).toBe(1);
    } finally {
      db.close();
    }
  });
  it('redacts unknown fields on write AND export and tolerates absent/failed storage', () => {
    const db = new DatabaseSync(':memory:');
    expect(readTransportDiagnostics(db, 's').available).toBe(false);
    const sink = new SqliteTransportDiagnostics(db);
    expect(() => sink.record('s', { kind: 'history', durationMs: 1 })).not.toThrow();
    migrate(db);
    for (const id of ['s', 'other'])
      db.prepare(
        "INSERT INTO relay_sessions(id, workspace_id, workspace_path, profile, state, desired_state, created_at, updated_at) VALUES (?, 'w', '/w', 'default', 'idle', 'running', 'now', 'now')",
      ).run(id);
    sink.record(
      's',
      { kind: 'history', durationMs: 2, ...{ prompt: 'private-secret', status: Infinity } },
      100,
    );
    db.prepare(
      'INSERT INTO chat_transport_diagnostics(session_id, occurred_at, metadata_json) VALUES (?, ?, ?)',
    ).run('s', 100, JSON.stringify({ kind: 'history', prompt: 'private-secret', coalesced: 9 }));
    const exported = readTransportDiagnostics(db, 's', 100);
    expect(exported.records).toHaveLength(2);
    expect(JSON.stringify(exported)).not.toContain('private-secret');
    expect(exported.records[1]?.coalesced).toBe(9);
    db.close();
  });
});
