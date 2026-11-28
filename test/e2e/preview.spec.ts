/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture } from './chat-relay-fixture.js';

test('opens an isolated preview tab and stops the selected chat preview', async ({
  page,
  context,
}) => {
  const origin = 'https://preview.example';
  const methods: string[] = [];
  const fixture = new ChatRelayFixture(page);
  await mockAuthenticatedStatus(page);
  await fixture.install([
    {
      id: 'preview-session',
      state: 'ready',
      desiredState: 'active',
      threadId: 'thread',
      workspaceId: 'workspace',
      workspacePath: '/workspace',
      profile: 'default',
      activeTurnId: null,
      pendingInteractions: [],
    },
  ]);
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      json: {
        workspaces: [],
        profiles: [],
        sessions: fixture.sessions,
        capabilities: { preview: true },
      },
    }),
  );
  await page.route('**/api/sessions/preview-session/preview', (route) => {
    const method = route.request().method();
    methods.push(method);
    return method === 'POST'
      ? route.fulfill({ json: { url: `${origin}/.gestalt-preview#one-time-code` } })
      : route.fulfill({ status: 204 });
  });
  await context.route(`${origin}/.gestalt-preview`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Local preview</h1>' }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const menu = page.getByRole('button', { name: 'Open configuration' });
  await menu.click();
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Open preview' }).click();
  const preview = await opened;
  await expect(preview.getByRole('heading', { name: 'Local preview' })).toBeVisible();
  expect(await preview.evaluate(() => window.opener === null)).toBe(true);

  await menu.click();
  await page.getByRole('button', { name: 'Stop preview' }).click();
  await expect(page.getByText('Preview stopped.')).toBeVisible();
  expect(methods).toEqual(['POST', 'DELETE']);
});
