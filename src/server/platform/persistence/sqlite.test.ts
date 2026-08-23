/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openRelayDatabase } from './sqlite.js';
import { migrate } from './migrate.js';
import { SqliteEventJournal } from './sqlite-event-journal.js';
import { SqliteIdempotencyStore } from './sqlite-idempotency-store.js';
import { SqliteSessionRepository } from './sqlite-session-repository.js';
import { SqlitePendingInteractionStore } from './sqlite-pending-interaction-store.js';
import { RelaySession } from '../../features/sessions/model/relay-session.js';

describe('SQLite relay persistence', () => {
  const directories: string[] = [];
  afterEach(async () =>
    Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))),
  );

  it('migrates idempotently and enables its required SQLite settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-db-'));
    directories.push(directory);
    const database = openRelayDatabase(join(directory, 'relay.sqlite'));

    migrate(database);
    migrate(database);

    expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    database.close();
  });

  it('round-trips a session-owned skill selection while preserving legacy rows without one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-db-'));
    directories.push(directory);
    const database = openRelayDatabase(join(directory, 'relay.sqlite'));
    migrate(database);
    const sessions = new SqliteSessionRepository(database);
    sessions.save(
      RelaySession.create({
        id: 'new',
        workspaceId: 'w',
        workspacePath: '/w',
        profile: 'default',
        now: 't',
        effectiveSkillSelection: {
          selectedProfileName: 'focused',
          skills: [{ name: 'Focused', path: '/skills/focused/SKILL.md', enabled: true }],
        },
      }).snapshot,
    );
    database
      .prepare(
        "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,created_at,updated_at) VALUES ('old','w','/w','default','ready','active','t','t')",
      )
      .run();

    expect(sessions.find('new')?.effectiveSkillSelection).toEqual({
      selectedProfileName: 'focused',
      skills: [{ name: 'Focused', path: '/skills/focused/SKILL.md', enabled: true }],
    });
    expect(sessions.find('old')?.effectiveSkillSelection).toBeUndefined();
    database.close();
  });

  it('orders events atomically and prunes the oldest entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-db-'));
    directories.push(directory);
    const database = openRelayDatabase(join(directory, 'relay.sqlite'));
    migrate(database);
    database
      .prepare(
        "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,created_at,updated_at) VALUES ('s','w','/w','default','ready','active','t','t')",
      )
      .run();
    const journal = new SqliteEventJournal(database, 2);

    journal.append('s', 'one', {}, 't1');
    journal.append('s', 'two', {}, 't2');
    journal.append('s', 'three', {}, 't3');

    expect(journal.since('s', 0).map((event) => event.sequence)).toEqual([2, 3]);
    expect(journal.tail('s', 1).map((event) => event.sequence)).toEqual([3]);
    expect(journal.tailWithTruncation('s', 1)).toMatchObject({
      events: [expect.objectContaining({ sequence: 3 })],
      truncated: true,
    });
    database.close();
  });

  it('replays a crash-surviving autopilot outbox record exactly once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-db-'));
    directories.push(directory);
    const database = openRelayDatabase(join(directory, 'relay.sqlite'));
    migrate(database);
    database
      .prepare(
        "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,created_at,updated_at) VALUES ('s','w','/w','default','ready','active','t','t')",
      )
      .run();
    const journal = new SqliteEventJournal(database);
    const first = journal.append('s', 'autopilot.control-issued', { controlId: 'opaque' }, 't', 41);
    const replay = journal.append(
      's',
      'autopilot.control-issued',
      { controlId: 'opaque' },
      't',
      41,
    );
    expect(replay.sequence).toBe(first.sequence);
    expect(journal.since('s', 0)).toHaveLength(1);
    database.close();
  });

  it('returns a bounded filtered autopilot audit tail even when recent journal rows are unrelated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-db-'));
    directories.push(directory);
    const database = openRelayDatabase(join(directory, 'relay.sqlite'));
    migrate(database);
    database
      .prepare(
        "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,created_at,updated_at) VALUES ('s','w','/w','default','ready','active','t','t')",
      )
      .run();
    const journal = new SqliteEventJournal(database);
    journal.append('s', 'autopilot.turn-started', { controlId: 'old' }, 't1');
    journal.append('s', 'autopilot.continuation-scheduled', { controlId: 'cancelled' }, 't2');
    journal.append('s', 'agentMessageDelta', { text: 'not audit' }, 't3');
    journal.append('s', 'autopilot.turn-failed', { controlId: 'new' }, 't4');
    journal.append('s', 'agentMessageDelta', { text: 'still not audit' }, 't5');
    expect(journal.autopilotAuditTail('s', 1)).toMatchObject({
      events: [expect.objectContaining({ type: 'autopilot.turn-failed', sequence: 4 })],
      truncated: true,
    });
    expect(journal.autopilotAuditTail('s', 2)).toMatchObject({
      events: [
        expect.objectContaining({ type: 'autopilot.turn-started', sequence: 1 }),
        expect.objectContaining({ type: 'autopilot.turn-failed', sequence: 4 }),
      ],
      truncated: false,
    });
    database.close();
  });

  it('excludes monitoring and obsolete plan-progress records from the renderable tail', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-db-'));
    directories.push(directory);
    const database = openRelayDatabase(join(directory, 'relay.sqlite'));
    migrate(database);
    database
      .prepare(
        "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,created_at,updated_at) VALUES ('s','w','/w','default','ready','active','t','t')",
      )
      .run();
    const journal = new SqliteEventJournal(database);
    journal.append('s', 'autopilot.turn-failed', { controlId: 'old' }, 't1');
    journal.append('s', 'autopilot.updated', { state: 'monitoring', enabled: true }, 'n1');
    journal.append('s', 'autopilot.progress-reset', { reason: 'planUpdated' }, 't2');
    journal.append('s', 'autopilot.updated', { state: 'completed', enabled: false }, 't3');

    const visibleOne = journal.autopilotAuditTail('s', 1);
    expect(visibleOne.events.map((event) => event.type)).toEqual(['autopilot.updated']);
    expect(visibleOne.events[0]?.payload).toMatchObject({ state: 'completed' });
    expect(visibleOne.truncated).toBe(true);
    const visibleTwo = journal.autopilotAuditTail('s', 2);
    expect(visibleTwo.events.map((event) => event.type)).toEqual([
      'autopilot.turn-failed',
      'autopilot.updated',
    ]);
    expect(visibleTwo.truncated).toBe(false);
    const indexes = database.prepare('PRAGMA index_list(session_events)').all() as Array<{
      name: string;
    }>;
    expect(indexes.map((index) => index.name)).toContain('session_events_autopilot_audit_tail_v2');
    database.close();
  });

  it('journals ordered plan replacement and close events per owning session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-db-'));
    directories.push(directory);
    const database = openRelayDatabase(join(directory, 'relay.sqlite'));
    migrate(database);
    for (const id of ['session-a', 'session-b']) {
      database
        .prepare(
          "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,created_at,updated_at) VALUES (?,?,?,'default','ready','active','t','t')",
        )
        .run(id, 'w', '/w');
    }
    const journal = new SqliteEventJournal(database);
    journal.append(
      'session-a',
      'plan.updated',
      { title: 'Complete replacement', allDone: true, currentStepId: 'done' },
      't1',
    );
    journal.append('session-b', 'plan.updated', { title: 'Other session' }, 't2');
    journal.append('session-a', 'plan.closed', {}, 't3');

    expect(journal.since('session-a', 0)).toMatchObject([
      {
        sessionId: 'session-a',
        sequence: 1,
        type: 'plan.updated',
        payload: { title: 'Complete replacement', allDone: true, currentStepId: 'done' },
      },
      { sessionId: 'session-a', sequence: 2, type: 'plan.closed', payload: {} },
    ]);
    expect(journal.since('session-b', 0)).toMatchObject([
      {
        sessionId: 'session-b',
        sequence: 1,
        type: 'plan.updated',
        payload: { title: 'Other session' },
      },
    ]);
    database.close();
  });

  it('replays idempotent response bytes exactly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-db-'));
    directories.push(directory);
    const database = openRelayDatabase(join(directory, 'relay.sqlite'));
    migrate(database);
    const store = new SqliteIdempotencyStore(database);

    store.put('start', 'key', 202, '{"session":"1"}');
    expect(store.get('start', 'key')).toEqual({ statusCode: 202, body: '{"session":"1"}' });
    database.close();
  });

  it('round trips a session snapshot across database reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-db-'));
    directories.push(directory);
    const path = join(directory, 'relay.sqlite');
    const database = openRelayDatabase(path);
    migrate(database);
    const repository = new SqliteSessionRepository(database);
    repository.save({
      id: 's',
      workspaceId: 'w',
      workspacePath: '/w',
      profile: 'default',
      threadId: 'thread',
      state: 'ready',
      desiredState: 'active',
      activeTurnId: null,
      protocolVersion: null,
      failureCount: 0,
      pendingInteractions: [],
      createdAt: 't',
      updatedAt: 't',
    });
    database.close();
    const reopened = openRelayDatabase(path);
    migrate(reopened);

    expect(new SqliteSessionRepository(reopened).find('s')).toMatchObject({
      id: 's',
      threadId: 'thread',
      state: 'ready',
    });
    reopened.close();
  });

  it('permits one pending interaction and one resolution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-db-'));
    directories.push(directory);
    const database = openRelayDatabase(join(directory, 'relay.sqlite'));
    migrate(database);
    database
      .prepare(
        "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,created_at,updated_at) VALUES ('s','w','/w','default','ready','active','t','t')",
      )
      .run();
    const store = new SqlitePendingInteractionStore(database);
    store.add('s', { requestId: 'i', kind: 'userInput', payload: {} });
    expect(store.list('s')).toEqual([{ requestId: 'i', kind: 'userInput', payload: {} }]);
    expect(store.resolve('s', 'i', 'later')).toBe(true);
    expect(store.list('s')).toEqual([]);
    expect(store.resolve('s', 'i', 'again')).toBe(false);
    store.add('s', {
      requestId: 'i',
      kind: 'commandApproval',
      payload: { command: 'git status' },
      turnId: 'turn-2',
      requestedAt: 'new',
    });
    expect(store.list('s')).toEqual([
      {
        requestId: 'i',
        kind: 'commandApproval',
        payload: { command: 'git status' },
        turnId: 'turn-2',
        requestedAt: 'new',
      },
    ]);
    database.close();
  });

  it('persists a retry-safe attention delivery state machine across reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-db-'));
    directories.push(directory);
    const path = join(directory, 'relay.sqlite');
    const database = openRelayDatabase(path);
    migrate(database);
    database
      .prepare(
        "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,created_at,updated_at) VALUES ('s','w','/w','default','ready','active','t','t')",
      )
      .run();
    const store = new SqlitePendingInteractionStore(database);
    store.add('s', { requestId: 'a', kind: 'orgPlanAttention', payload: { reason: 'hardBlock' } });
    expect(store.claimOperation('s', 'a', 'one')).toBe('claimed');
    expect(store.beginDelivery('s', 'a', 'one')).toBe(true);
    // A pre-delivery failure returns to a visible active interaction; only the
    // same operation can retry, so a competing browser action is stale.
    expect(store.retryDelivery('s', 'a', 'one')).toBe(true);
    expect(store.claimOperation('s', 'a', 'two')).toBe('stale');
    expect(store.beginDelivery('s', 'a', 'one')).toBe(true);
    database.close();

    const reopened = openRelayDatabase(path);
    migrate(reopened);
    const restored = new SqlitePendingInteractionStore(reopened);
    expect(restored.claimOperation('s', 'a', 'one')).toBe('same');
    expect(restored.claimOperation('s', 'a', 'two')).toBe('stale');
    expect(restored.settleOperation('s', 'a', 'one', 'later', 'answered')).toBe(true);
    expect(restored.list('s')).toEqual([]);
    expect(restored.resolved('s', 'a')).toEqual({ resolvedAt: 'later', outcome: 'answered' });
    reopened.close();

    // This is the recovery boundary after a crash between durable settlement
    // and writing the optional HTTP idempotency cache.
    const afterCrash = openRelayDatabase(path);
    migrate(afterCrash);
    const recovered = new SqlitePendingInteractionStore(afterCrash);
    expect(recovered.terminalOperation('s', 'a')).toEqual({
      resolvedAt: 'later',
      outcome: 'answered',
      operationKey: 'one',
    });
    expect(recovered.claimOperation('s', 'a', 'one')).toBe('resolved');
    expect(recovered.claimOperation('s', 'a', 'two')).toBe('stale');
    afterCrash.close();
  });

  it('durably claims one attention operation and never lets a duplicate request erase its audit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-db-'));
    directories.push(directory);
    const database = openRelayDatabase(join(directory, 'relay.sqlite'));
    migrate(database);
    database
      .prepare(
        "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,created_at,updated_at) VALUES ('s','w','/w','default','ready','active','t','t')",
      )
      .run();
    const store = new SqlitePendingInteractionStore(database);
    store.add('s', { requestId: 'a', kind: 'orgPlanAttention', payload: { safe: true } });
    expect(store.claimOperation('s', 'a', 'one')).toBe('claimed');
    expect(store.claimOperation('s', 'a', 'one')).toBe('same');
    expect(store.claimOperation('s', 'a', 'two')).toBe('stale');
    expect(store.resolve('s', 'a', 'later', 'answered')).toBe(true);
    store.add('s', { requestId: 'a', kind: 'orgPlanAttention', payload: { overwritten: true } });
    expect(store.resolved('s', 'a')).toEqual({ resolvedAt: 'later', outcome: 'answered' });
    expect(store.claimOperation('s', 'a', 'one')).toBe('resolved');
    database.close();
  });

  it('migrates interaction correlation and exposes resolved rows without response content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-db-'));
    directories.push(directory);
    const database = openRelayDatabase(join(directory, 'relay.sqlite'));
    migrate(database);
    database
      .prepare(
        "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,created_at,updated_at) VALUES ('s','w','/w','default','ready','active','t','t')",
      )
      .run();
    const store = new SqlitePendingInteractionStore(database);
    store.add('s', {
      requestId: 'pending',
      kind: 'quiz',
      payload: { question: 'safe' },
      turnId: 'turn-1',
      requestedAt: 't',
    });
    store.add('s', {
      requestId: 'resolved',
      kind: 'quiz',
      payload: { internal: 'secret-native-answer' },
      turnId: 'turn-1',
      requestedAt: 't',
    });
    expect(store.resolve('s', 'resolved', 'u', 'denied')).toBe(true);
    expect(store.snapshot('s')).toEqual([
      {
        requestId: 'pending',
        kind: 'quiz',
        turnId: 'turn-1',
        requestedAt: 't',
        resolvedAt: null,
        payload: { question: 'safe' },
      },
      {
        requestId: 'resolved',
        kind: 'quiz',
        turnId: 'turn-1',
        requestedAt: 't',
        resolvedAt: 'u',
        outcome: 'denied',
      },
    ]);
    expect(JSON.stringify(store.snapshot('s'))).not.toContain('secret-native-answer');
    database.close();
  });

  it('normalizes malformed persisted interaction outcomes at every read boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-db-'));
    directories.push(directory);
    const database = openRelayDatabase(join(directory, 'relay.sqlite'));
    migrate(database);
    database
      .prepare(
        "INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,created_at,updated_at) VALUES ('s','w','/w','default','ready','active','t','t')",
      )
      .run();
    const store = new SqlitePendingInteractionStore(database);
    store.add('s', {
      requestId: 'malformed',
      kind: 'userInput',
      payload: { answer: 'must-not-be-exposed' },
    });
    expect(store.resolve('s', 'malformed', 'resolved', 'approved')).toBe(true);
    database
      .prepare(
        "UPDATE pending_interactions SET outcome = 'unexpected' WHERE session_id = 's' AND request_id = 'malformed'",
      )
      .run();

    expect(store.resolved('s', 'malformed')).toEqual({
      resolvedAt: 'resolved',
      outcome: 'answered',
    });
    expect(store.snapshot('s')).toEqual([
      {
        requestId: 'malformed',
        kind: 'userInput',
        turnId: null,
        requestedAt: null,
        resolvedAt: 'resolved',
        outcome: 'answered',
      },
    ]);
    expect(JSON.stringify(store.snapshot('s'))).not.toContain('must-not-be-exposed');
    database.close();
  });

  it('migrates the prior interaction schema and preserves immutable safe outcomes after reload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-db-'));
    directories.push(directory);
    const path = join(directory, 'relay.sqlite');
    const database = openRelayDatabase(path);
    database.exec(
      "CREATE TABLE relay_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workspace_path TEXT NOT NULL, profile TEXT NOT NULL, model TEXT, branch TEXT, thread_id TEXT, state TEXT NOT NULL, desired_state TEXT NOT NULL, active_turn_id TEXT, protocol_version TEXT, failure_count INTEGER NOT NULL DEFAULT 0, effective_skill_selection_json TEXT, last_org_plan_json TEXT, next_sequence INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE pending_interactions (session_id TEXT NOT NULL, request_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, resolved_at TEXT, PRIMARY KEY (session_id,request_id)); INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,created_at,updated_at) VALUES ('s','w','/w','default','ready','active','t','t')",
    );
    migrate(database);
    expect(
      (
        database.prepare('PRAGMA table_info(pending_interactions)').all() as Array<{ name: string }>
      ).some((column) => column.name === 'outcome'),
    ).toBe(true);
    expect(
      (
        database.prepare('PRAGMA table_info(pending_interactions)').all() as Array<{ name: string }>
      ).some((column) => column.name === 'operation_key'),
    ).toBe(true);
    const store = new SqlitePendingInteractionStore(database);
    for (const [id, outcome] of [
      ['approved', 'approved'],
      ['denied', 'denied'],
      ['answered', 'answered'],
      ['dismissed', 'dismissed'],
    ] as const) {
      store.add('s', { requestId: id, kind: 'userInput', payload: { prompt: 'safe' } });
      expect(store.resolve('s', id, 'first', outcome)).toBe(true);
      expect(store.resolve('s', id, 'second', 'answered')).toBe(false);
      expect(store.resolved('s', id)).toEqual({ resolvedAt: 'first', outcome });
    }
    database.close();
    const reopened = openRelayDatabase(path);
    migrate(reopened);
    const snapshot = new SqlitePendingInteractionStore(reopened).snapshot('s');
    expect(snapshot.flatMap((item) => (item.resolvedAt === null ? [] : [item.outcome]))).toEqual([
      'approved',
      'denied',
      'answered',
      'dismissed',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('secret-native-answer');
    reopened.close();
  });
});
