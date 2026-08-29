/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';

import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture } from './chat-relay-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

const sessions = [
  {
    id: 'session-a',
    state: 'ready',
    threadId: 'thread-a',
    workspaceId: 'workspace-a',
    workspacePath: '/work/session-a',
    profile: 'default',
    model: 'gpt-5.6-sol',
    activeTurnId: null,
    pendingInteractions: [],
  },
  {
    id: 'session-b',
    state: 'ready',
    threadId: 'thread-b',
    workspaceId: 'workspace-b',
    workspacePath: '/work/session-b',
    profile: 'default',
    model: 'gpt-5.6-terra',
    activeTurnId: null,
    pendingInteractions: [],
  },
];

test('keeps the Chat pop-out available on touch-first mobile devices', async ({
  browser,
}, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== 'string') throw new Error('PLAYWRIGHT_BASE_URL_MISSING');

  const mobile = await browser.newContext({
    baseURL,
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  await mockAuthenticatedStatus(mobile);
  const fixture = new ChatRelayFixture(mobile);
  await fixture.install(sessions);
  fixture.snapshot('session-a', chatSnapshot());
  const page = await mobile.newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat' }).click();

  const popOut = page.getByRole('button', { name: 'Open Chat in a separate window' });
  await expect(popOut).toBeVisible();
  const detachedPromise = mobile.waitForEvent('page');
  await popOut.click();
  const detached = await detachedPromise;
  await expect(detached).toHaveURL(/\?chat-session=session-a$/);

  await mobile.close();
});

test('keeps a detached Chat pinned while the main window follows another session', async ({
  context,
  page,
}) => {
  const releases: string[] = [];
  context.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/release')) releases.push(request.url());
  });
  await mockAuthenticatedStatus(context);
  const fixture = new ChatRelayFixture(context);
  await fixture.install(sessions);
  fixture.snapshot(
    'session-a',
    chatSnapshot({
      items: [{ id: 'a-0', kind: 'agent', text: 'A before detach', phase: 'final_answer' }],
    }),
  );
  fixture.snapshot(
    'session-b',
    chatSnapshot({
      items: [{ id: 'b-0', kind: 'agent', text: 'B before selection', phase: 'final_answer' }],
    }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Chat' }).click();
  await expect(page.getByText('A before detach')).toBeVisible();
  const popupPromise = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Open Chat in a separate window' }).click();
  const detached = await popupPromise;
  await detached.waitForLoadState('domcontentloaded');

  await expect(detached).toHaveURL(/\?chat-session=session-a$/);
  await expect(detached.getByText('/work/session-a')).toBeVisible();
  await expect(detached.getByText('A before detach')).toBeVisible();
  await expect(detached.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  await expect(detached.getByRole('button', { name: 'Open configuration' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Sessions' }).click();
  const sessionB = page.getByText('/work/session-b').locator('xpath=ancestor::li');
  await sessionB.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByText('B before selection')).toBeVisible();
  await expect(page.getByText('A before detach')).toHaveCount(0);
  await expect(detached.getByText('A before detach')).toBeVisible();

  await expect.poll(() => fixture.sockets.has('session-a')).toBe(true);
  await expect.poll(() => fixture.sockets.has('session-b')).toBe(true);
  fixture.event('session-a', 1, 'agentMessageDelta', {
    itemId: 'a-live',
    turnId: 'turn-a',
    text: 'A continued in its detached window',
    phase: 'final_answer',
  });
  fixture.event('session-b', 1, 'agentMessageDelta', {
    itemId: 'b-live',
    turnId: 'turn-b',
    text: 'B continued in the main window',
    phase: 'final_answer',
  });
  await expect(detached.getByText('A continued in its detached window')).toBeVisible();
  await expect(page.getByText('B continued in the main window')).toBeVisible();
  await expect(detached.getByText('B continued in the main window')).toHaveCount(0);
  await expect(page.getByText('A continued in its detached window')).toHaveCount(0);

  await detached.close();
  expect(releases).toEqual([]);
  fixture.snapshot(
    'session-a',
    chatSnapshot({
      currentSequence: 1,
      items: [
        { id: 'a-0', kind: 'agent', text: 'A before detach', phase: 'final_answer' },
        {
          id: 'a-live',
          kind: 'agent',
          text: 'A continued in its detached window',
          phase: 'final_answer',
          turnId: 'turn-a',
        },
      ],
    }),
  );
  await page.getByRole('button', { name: 'Sessions' }).click();
  const sessionA = page.getByText('/work/session-a').locator('xpath=ancestor::li');
  await sessionA.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByText('A continued in its detached window')).toBeVisible();
});
