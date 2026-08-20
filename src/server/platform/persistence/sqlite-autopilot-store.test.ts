/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { SqliteAutopilotStore } from './sqlite-autopilot-store.js';

describe('SqliteAutopilotStore', () => {
  it('round-trips durable state and fails closed for corrupt enums', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.prepare(
      "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
    ).run();
    const store = new SqliteAutopilotStore(db);
    store.save({
      sessionId: 's',
      state: 'monitoring',
      requestedEnabled: true,
      planIdentity: 'i',
      planFingerprint: 'f',
      generation: 2,
      consecutiveNoProgress: 1,
      nextEvaluationAt: null,
      lastControlId: null,
      stopReason: null,
      updatedAt: '2026-08-20T00:00:00.000Z',
    });
    expect(store.find('s')).toMatchObject({ state: 'monitoring', generation: 2 });
    store.saveControl({
      sessionId: 's',
      controlId: 'control',
      status: 'issued',
      createdAt: 't',
      updatedAt: 't',
      failureCode: null,
    });
    expect(store.findControl('s', 'control')).toMatchObject({ status: 'issued' });
    expect(store.controlIds('s')).toEqual(new Set(['control']));
    expect(store.acceptedControlTurns('s')).toEqual(new Map());
    store.saveControl({
      sessionId: 's',
      controlId: 'control',
      status: 'started',
      createdAt: 't',
      updatedAt: 'later',
      failureCode: null,
    });
    store.saveControl({
      sessionId: 's',
      controlId: 'control',
      status: 'scheduled',
      createdAt: 't',
      updatedAt: 'latest',
      failureCode: null,
    });
    expect(store.findControl('s', 'control')).toMatchObject({ status: 'started' });
    store.saveControl({
      sessionId: 's',
      controlId: 'accepted-control',
      status: 'started',
      createdAt: 't',
      updatedAt: 'later',
      failureCode: null,
      turnId: 'synthetic-turn',
    });
    expect(store.acceptedControlTurns('s')).toEqual(
      new Map([['synthetic-turn', 'accepted-control']]),
    );
    store.saveControl({
      sessionId: 's',
      controlId: 'atomic-control',
      status: 'scheduled',
      createdAt: 't',
      updatedAt: 't',
      failureCode: null,
    });
    expect(store.claimControlIssued('s', 'atomic-control', 'claimed')).toMatchObject({
      status: 'issued',
      updatedAt: 'claimed',
    });
    expect(store.claimControlIssued('s', 'atomic-control', 'again')).toBeNull();
    db.prepare("UPDATE autopilot_sessions SET state = 'bad' WHERE session_id = 's'").run();
    expect(store.find('s')).toBeNull();
    db.close();
  });
  it('preserves an overdue backoff and issued ambiguity across a same-database reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-autopilot-reopen-'));
    const path = join(directory, 'relay.sqlite');
    try {
      const first = new DatabaseSync(path);
      migrate(first);
      first
        .prepare(
          "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
        )
        .run();
      const initial = new SqliteAutopilotStore(first);
      initial.save({
        sessionId: 's',
        state: 'backoff',
        requestedEnabled: true,
        planIdentity: 'identity',
        planFingerprint: 'fingerprint',
        generation: 7,
        consecutiveNoProgress: 2,
        nextEvaluationAt: '2026-08-20T00:00:00.000Z',
        lastControlId: 'opaque-control',
        stopReason: null,
        updatedAt: '2026-08-20T00:00:01.000Z',
      });
      initial.saveControl({
        sessionId: 's',
        controlId: 'opaque-control',
        status: 'issued',
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:01.000Z',
        failureCode: null,
      });
      first.close();

      const reopened = new DatabaseSync(path);
      migrate(reopened);
      const restored = new SqliteAutopilotStore(reopened);
      expect(restored.find('s')).toMatchObject({
        state: 'backoff',
        generation: 7,
        nextEvaluationAt: '2026-08-20T00:00:00.000Z',
        lastControlId: 'opaque-control',
      });
      expect(restored.findControl('s', 'opaque-control')).toMatchObject({ status: 'issued' });
      reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('durably records state, atomic issued claim, and audit intent before journal delivery', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.prepare(
      "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
    ).run();
    const store = new SqliteAutopilotStore(db);
    const scheduled = {
      sessionId: 's',
      state: 'backoff' as const,
      requestedEnabled: true,
      planIdentity: 'p',
      planFingerprint: 'f',
      generation: 1,
      consecutiveNoProgress: 0,
      nextEvaluationAt: '2026-08-20T00:00:00.000Z',
      lastControlId: 'c',
      stopReason: null,
      updatedAt: 't',
    };
    store.commit({
      state: scheduled,
      control: {
        sessionId: 's',
        controlId: 'c',
        status: 'scheduled',
        createdAt: 't',
        updatedAt: 't',
        failureCode: null,
      },
      events: [
        {
          sessionId: 's',
          type: 'autopilot.continuation-scheduled',
          payload: { controlId: 'c' },
          occurredAt: 't',
        },
      ],
    });
    const issued = {
      ...scheduled,
      state: 'monitoring' as const,
      consecutiveNoProgress: 1,
      nextEvaluationAt: null,
      updatedAt: 'u',
    };
    expect(
      store.claimControlIssued('s', 'c', 'u', issued, [
        {
          sessionId: 's',
          type: 'autopilot.control-issued',
          payload: { controlId: 'c' },
          occurredAt: 'u',
        },
      ]),
    ).toMatchObject({ status: 'issued' });
    expect(store.drainOutbox('s').map((event) => event.type)).toEqual([
      'autopilot.continuation-scheduled',
      'autopilot.control-issued',
    ]);
    expect(store.find('s')).toMatchObject({ state: 'monitoring', consecutiveNoProgress: 1 });
    db.close();
  });
});
