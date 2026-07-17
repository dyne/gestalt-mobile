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
    database.close();
  });
});
