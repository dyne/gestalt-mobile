/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

test.beforeEach(async ({ page }) => {
  await mockAuthenticatedStatus(page);
  await page.route('**/api/skill-profiles', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ profiles: [] }) }),
  );
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
});

test('re-reads an active Org plan when its tab is opened', async ({ page }) => {
  const session = {
    id: 'session-1',
    state: 'ready',
    threadId: 'thread-1',
    workspaceId: 'workspace-1',
    workspacePath: '/projects/workspace',
    profile: 'default',
    activeTurnId: null,
  };
  let planTitle = 'Plan before filesystem edit';
  const plan = () => ({
    title: planTitle,
    steps: [],
    totalSteps: 1,
    doneSteps: 0,
    allDone: false,
    currentStepId: 'work',
  });
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: [], profiles: [], sessions: [session] }),
    }),
  );
  await page.route(`**/api/sessions/${session.id}/history`, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(chatSnapshot()) }),
  );
  await page.route(`**/api/sessions/${session.id}/plan`, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(plan()) }),
  );
  await page.route('**/api/workspaces/workspace-1/plans', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.routeWebSocket(
    /ws:\/\/127\.0\.0\.1:4173\/api\/sessions\/session-1\/events\?after=\d+/,
    () => {},
  );

  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Plan' })).toBeVisible();
  planTitle = 'Plan after filesystem edit';
  await page.getByRole('button', { name: 'Plan' }).click();
  await expect(page.getByRole('heading', { name: planTitle })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Plan before filesystem edit' })).toHaveCount(0);
});

test('re-reads Git history after leaving and reopening the Git tab', async ({ page }) => {
  const repository = {
    id: 'repository',
    name: 'repository',
    relativePath: 'repository',
    isGitRepository: true,
    children: [],
  };
  let commit = { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', subject: 'Old commit' };
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: [
          {
            id: 'workspace-1',
            name: 'workspace',
            relativePath: '.',
            isGitRepository: false,
            children: [repository],
          },
        ],
        profiles: [],
        sessions: [],
      }),
    }),
  );
  await page.route('**/api/git/repositories/repository', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        available: true,
        branch: 'main',
        branches: ['main'],
        upstream: null,
        ahead: 0,
        behind: 0,
        dirty: { staged: 0, unstaged: 0, untracked: 0 },
        commits: [{ ...commit, author: 'Ada', authoredAt: '2026-08-15T10:00:00.000Z' }],
        fetchedAt: null,
      }),
    }),
  );

  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: 'Primary' });
  await navigation.getByRole('button', { name: 'Git' }).click();
  await page.getByRole('treeitem', { name: /^repository/ }).click();
  await expect(page.getByText('Old commit')).toBeVisible();

  commit = { hash: 'b'.repeat(40), shortHash: 'bbbbbbb', subject: 'New external commit' };
  await navigation.getByRole('button', { name: 'Sessions' }).click();
  await navigation.getByRole('button', { name: 'Git' }).click();
  await expect(page.getByText('New external commit')).toBeVisible();
  await expect(page.getByText('Old commit')).toHaveCount(0);
});
