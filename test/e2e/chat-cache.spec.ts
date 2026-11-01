/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture } from './chat-relay-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

async function persistedChat(page: Page): Promise<unknown> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('gestalt-mobile');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const transaction = db.transaction('chat-projections', 'readonly');
          const request = transaction.objectStore('chat-projections').get('session-1');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          transaction.oncomplete = () => db.close();
        };
      }),
  );
}

test(
  'upgrades v2 storage and restores redacted chat on reload before authoritative reconciliation',
  { tag: '@smoke' },
  async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockAuthenticatedStatus(page);
    const fixture = new ChatRelayFixture(page);
    await fixture.install([
      {
        id: 'session-1',
        state: 'ready',
        threadId: 'thread-1',
        workspaceId: 'workspace-1',
        workspacePath: '/workspace',
        profile: 'default',
        activeTurnId: null,
        pendingInteractions: [],
      },
    ]);
    // Seed an old installation on the same origin before loading application code.
    await page.route('**/cache-fixture', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Cache fixture</title>',
      }),
    );
    await page.goto('/cache-fixture');
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('gestalt-mobile', 2);
          open.onupgradeneeded = () => {
            for (const name of ['settings', 'drafts', 'cursors', 'messages'])
              open.result.createObjectStore(name);
          };
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction(['settings', 'drafts', 'cursors', 'messages'], 'readwrite');
            tx.objectStore('settings').put('preserved setting', 'migration-marker');
            tx.objectStore('drafts').put({ text: 'preserved draft', revision: 3 }, 'other-session');
            tx.objectStore('cursors').put(19, 'other-session');
            tx.objectStore('messages').put(
              [{ id: 'old', text: 'preserved message' }],
              'other-session',
            );
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
    );
    const initial = chatSnapshot({
      baseSequence: 5,
      items: [
        { id: 'user-1', kind: 'user', text: 'cached user prompt', turnId: 'turn-1' },
        { id: 'answer-1', kind: 'agent', text: 'private model output', turnId: 'turn-1' },
      ],
    });
    fixture.snapshot('session-1', initial);
    await page.goto('/');
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    const timeline = page.getByLabel('Chat messages');
    await expect(timeline.getByText('cached user prompt', { exact: true })).toBeVisible();
    await expect(timeline.getByText('private model output', { exact: true })).toBeVisible();
    await expect
      .poll(async () => JSON.stringify(await persistedChat(page)))
      .toContain('cached user prompt');

    // Exercise the production adapter in Chromium with sensitive retry/payload values.
    const preserved = await page.evaluate(async () => {
      const cachePath = '/src/client/features/chat/chat-cache.ts';
      const projectionPath = '/src/client/features/chat/chat-projection.ts';
      const databasePath = '/src/client/features/client-database.ts';
      const { createChatCache } = (await import(
        cachePath
      )) as typeof import('../../src/client/features/chat/chat-cache.js');
      const { createChatProjection, failInteraction } = (await import(
        projectionPath
      )) as typeof import('../../src/client/features/chat/chat-projection.js');
      const projection = failInteraction(
        {
          ...createChatProjection('session-1'),
          cursor: 5,
          messages: [
            { id: 'user-1', role: 'user', text: 'cached user prompt', complete: true },
            { id: 'answer-1', role: 'assistant', text: 'private model output', complete: true },
          ],
          interactions: [
            {
              requestId: 'quiz-1',
              key: 'quiz-1',
              kind: 'quiz',
              state: 'submitting',
              payload: { token: 'private payload' },
            },
          ],
        },
        'quiz-1',
        { answer: 'private answer' },
      );
      await createChatCache().write('session-1', projection);
      const { openClientDatabase, readStore } = (await import(
        databasePath
      )) as typeof import('../../src/client/features/client-database.js');
      const db = await openClientDatabase(indexedDB);
      try {
        return {
          version: db.version,
          setting: await readStore(db, 'settings', 'migration-marker'),
          draft: await readStore(db, 'drafts', 'other-session'),
          cursor: await readStore(db, 'cursors', 'other-session'),
          messages: await readStore(db, 'messages', 'other-session'),
        };
      } finally {
        db.close();
      }
    });
    expect(preserved).toEqual({
      version: 3,
      setting: 'preserved setting',
      draft: { text: 'preserved draft', revision: 3 },
      cursor: 19,
      messages: [{ id: 'old', text: 'preserved message' }],
    });
    const stored = JSON.stringify(await persistedChat(page));
    expect(stored).toContain('cached user prompt');
    expect(stored).toContain('quiz-1');
    expect(stored).not.toContain('private');

    const canonical = chatSnapshot({
      baseSequence: 8,
      items: [
        { id: 'user-1', kind: 'user', text: 'canonical user prompt', turnId: 'turn-1' },
        { id: 'answer-1', kind: 'agent', text: 'canonical server answer', turnId: 'turn-1' },
      ],
    });
    const history = fixture.deferHistory('session-1');
    const readsBeforeReload = fixture.protocol.filter((call) => call.kind === 'history').length;
    try {
      await page.reload();
      await page.getByRole('button', { name: 'Chat', exact: true }).click();
      await expect
        .poll(() => fixture.protocol.filter((call) => call.kind === 'history').length)
        .toBeGreaterThan(readsBeforeReload);
      await expect(timeline.getByText('cached user prompt', { exact: true })).toBeVisible();
      await expect(timeline.getByText('private model output', { exact: true })).toHaveCount(0);
      await expect(timeline.getByText('canonical server answer', { exact: true })).toHaveCount(0);
      history.resolve(canonical);
      await expect(timeline.getByText('canonical user prompt', { exact: true })).toHaveCount(1);
      await expect(timeline.getByText('canonical server answer', { exact: true })).toHaveCount(1);
      await expect(timeline.getByText('cached user prompt', { exact: true })).toHaveCount(0);
      await expect(timeline.getByRole('listitem')).toHaveCount(2);
      await expect
        .poll(async () => JSON.stringify(await persistedChat(page)))
        .toContain('canonical user prompt');
      expect(JSON.stringify(await persistedChat(page))).not.toContain('canonical server answer');
    } finally {
      history.resolve(canonical);
    }
  },
);
