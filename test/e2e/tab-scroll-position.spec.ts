/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';

test.beforeEach(async ({ page }) => mockAuthenticatedStatus(page));

const sessions = Array.from({ length: 24 }, (_, index) => ({
  id: `session-${index + 1}`,
  state: 'ready',
  threadId: `thread-${index + 1}`,
  workspaceId: `workspace-${index + 1}`,
  workspacePath: `/projects/workspace-${index + 1}`,
  profile: 'default',
  activeTurnId: null,
}));

test('focuses the prompt when Chat is selected on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: [], profiles: [], sessions: [sessions[0]] }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ items: [], currentSequence: 0 }),
    }),
  );
  await page.route('**/api/sessions/session-1/plan', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/skill-profiles', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ profiles: [] }) }),
  );
  await page.routeWebSocket(
    /ws:\/\/127\.0\.0\.1:4173\/api\/sessions\/session-1\/events\?after=\d+/,
    () => {},
  );

  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: 'Primary' });
  await navigation.getByRole('button', { name: 'Chat' }).click();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeFocused();
});

test('opens Chat at the bottom and every other tab at the top', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: [], profiles: [], sessions }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: Array.from({ length: 40 }, (_, index) => ({
          id: `message-${index + 1}`,
          kind: index % 2 === 0 ? 'user' : 'agent',
          text: `Message ${index + 1}: enough content to keep the Chat view scrollable.`,
          occurredAt: index + 1,
        })),
        currentSequence: 0,
      }),
    }),
  );
  await page.route('**/api/sessions/session-1/plan', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/skill-profiles', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ profiles: [] }) }),
  );
  await page.routeWebSocket(
    /ws:\/\/127\.0\.0\.1:4173\/api\/sessions\/session-1\/events\?after=\d+/,
    () => {},
  );

  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: 'Primary' });
  const chat = navigation.getByRole('button', { name: 'Chat' });
  await chat.click();
  await expect(chat).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight - window.scrollY,
      ),
    )
    .toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  await navigation.getByRole('button', { name: 'Sessions' }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await navigation.getByRole('button', { name: 'Git' }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});
