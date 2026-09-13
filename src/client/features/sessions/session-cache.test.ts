/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const persistence = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  failWrite: false,
  failNextWrite: false,
  writeAttempts: 0,
  writeBarrier: null as Promise<void> | null,
}));
vi.mock('../client-database.js', () => ({
  openClientDatabase: async () => ({}),
  readStore: async (_db: unknown, store: string, key: string) =>
    persistence.values.get(`${store}:${key}`),
  writeStore: async (_db: unknown, store: string, key: string, value: unknown) => {
    persistence.writeAttempts += 1;
    if (persistence.writeBarrier) await persistence.writeBarrier;
    if (persistence.failNextWrite) {
      persistence.failNextWrite = false;
      throw new Error('storage unavailable');
    }
    if (persistence.failWrite) throw new Error('storage unavailable');
    persistence.values.set(`${store}:${key}`, value);
  },
  deleteStore: async (_db: unknown, store: string, key: string) => {
    persistence.values.delete(`${store}:${key}`);
  },
}));

import { createSessionCache } from './session-cache.js';

describe('session cache', () => {
  beforeEach(() => {
    persistence.values.clear();
    persistence.failWrite = false;
    persistence.failNextWrite = false;
    persistence.writeAttempts = 0;
    persistence.writeBarrier = null;
  });
  it('uses harmless defaults when IndexedDB is unavailable', async () => {
    const cache = createSessionCache(undefined);

    await cache.saveSelectedSession('session-1');
    await cache.saveDraft('session-1', 'keep this draft');
    await cache.saveCursor('session-1', 12);

    await expect(cache.readSelectedSession()).resolves.toBeNull();
    await expect(cache.readDraft('session-1')).resolves.toBe('');
    await expect(cache.readDraftEnvelope('session-1')).resolves.toEqual({ text: '', revision: 0 });
    await expect(cache.readCursor('session-1')).resolves.toBe(0);
  });
  it('migrates legacy strings and rejects malformed stored drafts', async () => {
    persistence.values.set('drafts:s', 'legacy draft');
    const cache = createSessionCache({} as IDBFactory);
    await expect(cache.readDraftEnvelope('s')).resolves.toEqual({
      text: 'legacy draft',
      revision: 0,
    });
    persistence.values.set('drafts:bad', { text: 1, revision: -1 });
    await expect(cache.readDraftEnvelope('bad')).resolves.toEqual({ text: '', revision: 0 });
  });
  it('round-trips bounded pending recovery and conditionally tombstones only its matching operation', async () => {
    const cache = createSessionCache({} as IDBFactory);
    await cache.saveDraftEnvelope('s', { text: 'draft', revision: 3 });
    for (let index = 0; index < 9; index += 1)
      await cache.addPendingDraftOperation('s', {
        operationId: `op-${index}`,
        text: 'draft',
        revision: 3,
        kind: 'send',
      });
    const stored = await cache.readDraftEnvelope('s');
    expect(stored.pending).toHaveLength(8);
    await expect(cache.consumeAcceptedDraft('s', 2, 'op-8')).resolves.toBeNull();
    await expect(cache.consumeAcceptedDraft('s', 3, 'missing')).resolves.toBeNull();
    await expect(cache.consumeAcceptedDraft('s', 3, 'op-8')).resolves.toMatchObject({
      text: '',
      revision: 4,
    });
  });
  it('does not claim an accepted tombstone when persistence fails', async () => {
    const cache = createSessionCache({} as IDBFactory);
    await cache.saveDraftEnvelope('s', {
      text: 'draft',
      revision: 1,
      pending: [{ operationId: 'op', text: 'draft', revision: 1, kind: 'send' }],
    });
    persistence.failWrite = true;
    await expect(cache.consumeAcceptedDraft('s', 1, 'op')).resolves.toBeNull();
    persistence.failWrite = false;
    await expect(cache.readDraftEnvelope('s')).resolves.toMatchObject({
      text: 'draft',
      revision: 1,
    });
  });
  it('serializes a delayed draft write before its accepted tombstone', async () => {
    let release!: () => void;
    persistence.writeBarrier = new Promise<void>((resolve) => (release = resolve));
    const cache = createSessionCache({} as IDBFactory);
    const staleWrite = cache.saveDraftEnvelope('s', {
      text: 'draft',
      revision: 3,
      pending: [{ operationId: 'op', text: 'draft', revision: 3, kind: 'send' }],
    });
    await Promise.resolve();
    const accepted = cache.consumeAcceptedDraft('s', 3, 'op');
    release();
    await staleWrite;
    await expect(accepted).resolves.toMatchObject({ text: '', revision: 4, pending: [] });
    await expect(cache.readDraftEnvelope('s')).resolves.toMatchObject({ text: '', revision: 4 });
  });
  it('keeps a newer edit when its preceding accepted tombstone write fails', async () => {
    const cache = createSessionCache({} as IDBFactory);
    await cache.saveDraftEnvelope('s', {
      text: 'submitted draft',
      revision: 3,
      pending: [{ operationId: 'op', text: 'submitted draft', revision: 3, kind: 'send' }],
    });
    let release!: () => void;
    persistence.writeBarrier = new Promise<void>((resolve) => (release = resolve));
    persistence.failNextWrite = true;
    const accepted = cache.consumeAcceptedDraft('s', 3, 'op');
    await vi.waitFor(() => expect(persistence.writeAttempts).toBe(2));
    const newerEdit = cache.replaceDraftText('s', 'newer edit', 4);
    release();
    await expect(accepted).resolves.toBeNull();
    await newerEdit;
    await expect(cache.readDraftEnvelope('s')).resolves.toMatchObject({
      text: 'newer edit',
      revision: 4,
    });
    expect(persistence.values.get('drafts:s')).toMatchObject({ text: 'newer edit', revision: 4 });
  });
});
