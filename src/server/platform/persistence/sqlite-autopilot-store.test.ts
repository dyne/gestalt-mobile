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
      executor: {
        canonicalPosition: 'L4',
        canonicalTaskName: 'l4',
        taskPath: '/root/l4_g2',
        threadId: 'executor-thread',
        l1State: 'WIP',
        l2State: 'DONE',
        lastActivityAt: '2026-08-20T00:00:00.000Z',
        ownedProcesses: [
          {
            processId: 'process-1',
            itemId: 'item-1',
            ownerThreadId: 'executor-thread',
            ownerTaskPath: '/root/l4_g2',
            ownership: 'supervisor',
            state: 'detached-active',
            observedAt: '2026-08-20T00:00:00.000Z',
            elapsedMs: 1_000,
            cpuPercent: 99,
            rssBytes: 1_024,
            osPid: 123,
          },
        ],
        outcome: 'partial',
        continuationGeneration: 2,
        continuationCount: 1,
      },
      updatedAt: '2026-08-20T00:00:00.000Z',
    });
    expect(store.find('s')).toMatchObject({
      state: 'monitoring',
      generation: 2,
      executor: {
        canonicalPosition: 'L4',
        taskPath: '/root/l4_g2',
        ownedProcesses: [{ processId: 'process-1', ownership: 'supervisor' }],
      },
    });
    store.save({
      ...store.find('s')!,
      state: 'attentionRequired',
      requestedEnabled: false,
      stopReason: 'startUnavailable',
    });
    expect(store.find('s')).toMatchObject({ stopReason: 'startUnavailable' });
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
      controlId: 'cancelled-control',
      status: 'scheduled',
      createdAt: 't',
      updatedAt: 't',
      failureCode: null,
    });
    store.saveControl({
      sessionId: 's',
      controlId: 'cancelled-control',
      status: 'cancelled',
      createdAt: 't',
      updatedAt: 'cancelled',
      failureCode: null,
    });
    store.saveControl({
      sessionId: 's',
      controlId: 'cancelled-control',
      status: 'issued',
      createdAt: 't',
      updatedAt: 'late-claim',
      failureCode: null,
    });
    expect(store.findControl('s', 'cancelled-control')).toMatchObject({
      status: 'cancelled',
      updatedAt: 'cancelled',
    });
    expect(store.claimControlIssued('s', 'cancelled-control', 'claim')).toBeNull();
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
    expect(store.automaticActionsSince('s', '')).toBe(3);
    expect(store.automaticActionsSince('s', 'zzzz')).toBe(0);
    db.prepare("UPDATE autopilot_sessions SET state = 'bad' WHERE session_id = 's'").run();
    expect(store.find('s')).toBeNull();
    db.close();
  });
  it('migrates legacy sessions and rejects malformed lifecycle state', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      'CREATE TABLE relay_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workspace_path TEXT NOT NULL, profile TEXT NOT NULL, thread_id TEXT, state TEXT NOT NULL, desired_state TEXT NOT NULL, active_turn_id TEXT, protocol_version TEXT, failure_count INTEGER NOT NULL DEFAULT 0, next_sequence INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE autopilot_sessions (session_id TEXT PRIMARY KEY REFERENCES relay_sessions(id) ON DELETE CASCADE, state TEXT NOT NULL, requested_enabled INTEGER NOT NULL, plan_identity TEXT, plan_fingerprint TEXT, generation INTEGER NOT NULL, no_progress_count INTEGER NOT NULL, next_evaluation_at TEXT, last_control_id TEXT, stop_reason TEXT, updated_at TEXT NOT NULL);',
    );
    migrate(db);
    const columns = db.prepare('PRAGMA table_info(autopilot_sessions)').all() as Array<{
      name: string;
    }>;
    expect(columns.some((column) => column.name === 'lifecycle_json')).toBe(true);
    db.prepare(
      "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,failure_count,next_sequence,created_at,updated_at) VALUES ('s','w','/w','p','ready','active',0,1,'t','t')",
    ).run();
    db.prepare(
      "INSERT INTO autopilot_sessions (session_id,state,requested_enabled,plan_identity,plan_fingerprint,generation,no_progress_count,next_evaluation_at,last_control_id,stop_reason,lifecycle_json,updated_at) VALUES ('s','monitoring',1,'i','f',1,0,NULL,NULL,NULL,'{\"blocking\":{\"reason\":\"permissionRequired\",\"resumeCondition\":\"userGuidance\"}}','t')",
    ).run();
    expect(new SqliteAutopilotStore(db).find('s')).toBeNull();
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
