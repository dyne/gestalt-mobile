/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, it, vi } from 'vitest';
import { openClientDatabase, readStore, writeStore } from '../client-database.js';
import { createChatCache, serializeChatCache } from './chat-cache.js';
import { createChatProjection, failInteraction, hydrateCache } from './chat-projection.js';
import { resolveInteraction } from './chat-projection.js';

/** Narrow IndexedDB fixture: async requests, version upgrades, and strict store lookup. */
function indexedDatabaseFixture(populated = false): IDBFactory {
  const stores = new Map<string, Map<IDBValidKey, unknown>>();
  let version = populated ? 2 : 0;
  if (populated) {
    stores.set('settings', new Map([['selected-session', 's']]));
    stores.set('drafts', new Map([['s', { text: 'unsent draft', revision: 3 }]]));
    stores.set('cursors', new Map([['s', 12]]));
    stores.set('messages', new Map([['s', [{ id: 'old', text: 'existing message' }]]]));
  }
  const request = (operation: () => unknown) => {
    const result = {} as IDBRequest;
    queueMicrotask(() => {
      try {
        Object.assign(result, { result: structuredClone(operation()) });
        result.onsuccess?.call(result, new Event('success'));
      } catch (error) {
        Object.assign(result, { error });
        result.onerror?.call(result, new Event('error'));
      }
    });
    return result;
  };
  const db = {
    get version() {
      return version;
    },
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore(name: string) {
      if (stores.has(name)) throw new DOMException('Store exists', 'ConstraintError');
      stores.set(name, new Map());
    },
    transaction(name: string, mode: IDBTransactionMode) {
      const values = stores.get(name);
      if (!values) throw new DOMException(`Missing store: ${name}`, 'NotFoundError');
      return {
        objectStore: () => ({
          get: (key: IDBValidKey) => request(() => values.get(key)),
          put: (value: unknown, key: IDBValidKey) => {
            if (mode !== 'readwrite') throw new DOMException('Read only', 'ReadOnlyError');
            const copy = structuredClone(value);
            return request(() => {
              values.set(key, copy);
              return key;
            });
          },
        }),
      };
    },
  };
  return {
    open(_name: string, requestedVersion: number) {
      const result = {} as IDBOpenDBRequest;
      queueMicrotask(() => {
        if (requestedVersion < version) {
          Object.assign(result, { error: new DOMException('Older version', 'VersionError') });
          result.onerror?.call(result, new Event('error'));
          return;
        }
        Object.assign(result, { result: db });
        if (requestedVersion > version) {
          version = requestedVersion;
          result.onupgradeneeded?.call(result, new Event('upgradeneeded') as IDBVersionChangeEvent);
        }
        result.onsuccess?.call(result, new Event('success'));
      });
      return result;
    },
  } as unknown as IDBFactory;
}

for (const populated of [false, true]) {
  it(`round-trips redacted chat projections in a ${populated ? 'populated version-2' : 'fresh'} database`, async () => {
    const database = indexedDatabaseFixture(populated);
    const cache = createChatCache(database);
    const projection = failInteraction(
      {
        ...createChatProjection('s'),
        cursor: 12,
        messages: [
          { id: 'u', role: 'user', text: 'keep user prompt', complete: true },
          { id: 'a', role: 'assistant', text: 'private model output', complete: true },
        ],
        interactions: [
          {
            requestId: 'q',
            key: 'q',
            kind: 'quiz',
            payload: { token: 'private payload' },
            state: 'submitting',
            operationId: 'operation-1',
          },
        ],
      },
      'q',
      { answer: 'private answer' },
    );
    await cache.write('s', projection);
    const db = await openClientDatabase(database);
    for (const name of ['settings', 'drafts', 'cursors', 'messages'])
      expect(db.objectStoreNames.contains(name)).toBe(true);
    if (populated) {
      await expect(readStore(db, 'settings', 'selected-session')).resolves.toBe('s');
      await expect(readStore(db, 'drafts', 's')).resolves.toEqual({
        text: 'unsent draft',
        revision: 3,
      });
      await expect(readStore(db, 'cursors', 's')).resolves.toBe(12);
      await expect(readStore(db, 'messages', 's')).resolves.toEqual([
        { id: 'old', text: 'existing message' },
      ]);
    }
    const restored = await createChatCache(database).read('s');
    expect(restored).toEqual(serializeChatCache(projection));
    expect(JSON.stringify(restored)).not.toContain('private');
    expect(hydrateCache('s', restored).messages).toEqual([
      { id: 'u', role: 'user', text: 'keep user prompt', complete: true },
    ]);
  });
}

it('retains projections for separate sessions through repeated database opens', async () => {
  const database = indexedDatabaseFixture(true);
  const first = { ...createChatProjection('first'), cursor: 8 };
  const second = { ...createChatProjection('second'), cursor: 15 };
  await createChatCache(database).write('first', first);
  const reopened = await openClientDatabase(database);
  expect(reopened.version).toBe(3);
  expect(reopened.objectStoreNames.contains('chat-projections')).toBe(true);
  await createChatCache(database).write('second', second);
  const cache = createChatCache(database);
  await expect(cache.read('first')).resolves.toEqual(serializeChatCache(first));
  await expect(cache.read('second')).resolves.toEqual(serializeChatCache(second));
});

it('uses harmless defaults when IndexedDB is unavailable', async () => {
  vi.stubGlobal('indexedDB', undefined);
  try {
    const cache = createChatCache();
    await expect(cache.write('s', createChatProjection('s'))).resolves.toBeUndefined();
    await expect(cache.read('s')).resolves.toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

for (const synchronous of [true, false]) {
  it(`keeps ${synchronous ? 'synchronous' : 'asynchronous'} storage denial nonfatal before cache use`, async () => {
    const denied = {
      open() {
        const error = new DOMException('Storage denied', 'SecurityError');
        if (synchronous) throw error;
        const request = {} as IDBOpenDBRequest;
        queueMicrotask(() => {
          Object.assign(request, { error });
          request.onerror?.call(request, new Event('error'));
        });
        return request;
      },
    } as unknown as IDBFactory;
    const cache = createChatCache(denied);
    // Allow eager open rejection to surface as unhandled if no handler was attached.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(cache.read('s')).resolves.toBeNull();
    await expect(cache.write('s', createChatProjection('s'))).resolves.toBeUndefined();
  });
}

it('hydrates malformed persisted data harmlessly and can replace it with a valid projection', async () => {
  const database = indexedDatabaseFixture();
  const db = await openClientDatabase(database);
  await writeStore(db, 'chat-projections', 's', { version: 1, messages: 'invalid', cursor: -1 });
  const cache = createChatCache(database);
  expect(hydrateCache('s', await cache.read('s'))).toEqual(createChatProjection('s'));
  const projection = { ...createChatProjection('s'), cursor: 9 };
  await cache.write('s', projection);
  await expect(cache.read('s')).resolves.toEqual(serializeChatCache(projection));
});

it('redacts assistant output, arbitrary interaction payloads, and secret retry values', () => {
  const projection = failInteraction(
    {
      ...createChatProjection('s'),
      messages: [{ id: 'a', role: 'assistant', text: 'model output', complete: true }],
      interactions: [
        {
          requestId: 'r',
          key: 'r',
          kind: 'quiz',
          payload: { secret: 'no' },
          state: 'submitting',
          operationId: 'k',
        },
      ],
    },
    'r',
    { secret: 'no' },
  );
  const cached = JSON.stringify(serializeChatCache(projection));
  expect(cached).not.toContain('model output');
  expect(cached).not.toContain('secret');
  expect(cached).not.toContain('no');
});
it('keeps only safe approval decision shape through reload', () => {
  const projection = failInteraction(
    {
      ...createChatProjection('s'),
      interactions: [
        {
          requestId: 'r',
          key: 'r',
          kind: 'commandApproval',
          payload: {},
          state: 'submitting',
          operationId: 'k',
        },
      ],
    },
    'r',
    { decision: 'accept' },
  );
  expect(hydrateCache('s', serializeChatCache(projection)).interactions[0]).toMatchObject({
    operationId: 'k',
    attemptedOutcome: { decision: 'accept' },
  });
});
it('normalizes malformed cached lifecycle and active turn', () => {
  const hydrated = hydrateCache('s', {
    cursor: 0,
    lifecycle: 'evil',
    activeTurnId: 7,
    messages: [],
    prompts: [],
    interactions: [],
  });
  expect(hydrated).toMatchObject({ lifecycle: 'finished', activeTurnId: null });
});
it('redacts quiz answers so reload requires re-entry', () => {
  const projection = failInteraction(
    {
      ...createChatProjection('s'),
      interactions: [
        {
          requestId: 'q',
          key: 'q',
          kind: 'quiz',
          payload: {},
          state: 'submitting',
          operationId: 'key',
        },
      ],
    },
    'q',
    { answer: 'secret' },
  );
  const json = JSON.stringify(serializeChatCache(projection));
  expect(json).not.toContain('secret');
  expect(
    hydrateCache('s', serializeChatCache(projection)).interactions[0]?.attemptedOutcome,
  ).toBeUndefined();
});
it('retains only safe resolved denial and answer outcomes across reload', () => {
  const projection = {
    ...createChatProjection('s'),
    interactions: [
      { requestId: 'd', key: 'd', kind: 'commandApproval', payload: {}, state: 'pending' as const },
      { requestId: 'a', key: 'a', kind: 'quiz', payload: {}, state: 'pending' as const },
    ],
  };
  const resolved = resolveInteraction(
    resolveInteraction(projection, 'd', { decision: 'decline' }),
    'a',
    { answer: 'secret' },
  );
  const cached = JSON.stringify(serializeChatCache(resolved));
  expect(cached).not.toContain('secret');
  expect(
    hydrateCache('s', JSON.parse(cached)).interactions.map((item) => item.attemptedOutcome),
  ).toEqual(['denied', 'answered']);
});
