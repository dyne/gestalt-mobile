/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

test.beforeEach(async ({ page }) => mockAuthenticatedStatus(page));

const bootstrap = (sessions: Array<Record<string, unknown>>, providers?: unknown) => ({
  workspaces: [
    {
      id: 'workspace-1',
      name: 'project',
      relativePath: '.',
      isGitRepository: false,
      children: [],
    },
  ],
  profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
  models: { codex: ['gpt-5.6-terra'], kimi: ['k2-thinking', 'k2-fast'] },
  sessions,
  capabilities: {
    approvals: true,
    userInput: true,
    git: true,
    protocolCompatible: true,
    ...(providers ? { providers } : {}),
  },
});

const kimiProviders = {
  codex: { available: true, version: '1.0.0' },
  kimi: { available: true, version: '2.0.2' },
};

async function openChat(page: Page): Promise<void> {
  const chat = page.getByRole('button', { name: 'Chat' });
  await expect(chat).toBeEnabled();
  await chat.click();
  await expect(page.getByRole('button', { name: 'Chat', pressed: true })).toBeVisible();
}

test('starts a kimi session from the provider picker and adapts the form', async ({ page }) => {
  let startBody: unknown;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(bootstrap([], kimiProviders)),
    }),
  );
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ contentType: 'application/json', body: '[]' });
      return;
    }
    startBody = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'kimi-session-1',
        state: 'ready',
        workspacePath: '/project',
        provider: 'kimi',
        model: 'k2-thinking',
      }),
    });
  });
  await page.route('**/api/sessions/kimi-session-1/history', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(chatSnapshot()) }),
  );
  await page.route('**/api/sessions/kimi-session-1', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'kimi-session-1',
        state: 'ready',
        workspacePath: '/project',
        provider: 'kimi',
        model: 'k2-thinking',
      }),
    }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions' }).click();

  const provider = page.getByLabel('Provider');
  await expect(provider).toHaveValue('codex');
  await expect(page.getByLabel('Sandbox')).toBeVisible();
  await expect(page.getByText(/Codex should use as its working directory/)).toBeVisible();

  await provider.selectOption('kimi');
  await expect(page.getByLabel('Sandbox')).toHaveCount(0);
  await expect(page.getByLabel('Approval policy')).toHaveCount(0);
  await expect(page.getByText(/Kimi should use as its working directory/)).toBeVisible();
  await expect(page.getByLabel('Model')).toHaveValue('k2-thinking');
  await expect(page.getByLabel('Model')).toContainText('k2-fast');

  await page.getByRole('button', { name: 'Create session' }).click();
  await expect
    .poll(() => startBody)
    .toEqual({
      workspaceId: 'workspace-1',
      profile: 'default',
      provider: 'kimi',
      model: 'k2-thinking',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    });
  await expect(page.getByRole('button', { name: 'Chat', pressed: true })).toBeVisible();
});

test('hides the provider picker when kimi is not installed', async ({ page }) => {
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        bootstrap([], {
          codex: { available: true, version: '1.0.0' },
          kimi: { available: false },
        }),
      ),
    }),
  );
  await page.route('**/api/sessions', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions' }).click();
  await expect(page.getByLabel('Provider')).toHaveCount(0);
  await expect(page.getByLabel('Sandbox')).toBeVisible();
  await expect(page.getByLabel('Model')).toHaveValue('gpt-5.6-terra');
});

test('restricts chat model switching to the session provider and badges kimi sessions', async ({
  page,
}) => {
  const kimiSession = {
    id: 'kimi-session-1',
    state: 'ready',
    workspacePath: '/project',
    provider: 'kimi',
    model: 'k2-thinking',
    activeTurnId: null,
  };
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(bootstrap([kimiSession], kimiProviders)),
    }),
  );
  await page.route('**/api/sessions/kimi-session-1/history', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(chatSnapshot()) }),
  );
  await page.routeWebSocket(
    /ws:\/\/127\.0\.0\.1:\d+\/api\/sessions\/kimi-session-1\/events\?after=\d+/,
    () => {},
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions' }).click();
  const openSessions = page.getByLabel('Open sessions');
  await expect(openSessions.getByText('Kimi')).toBeVisible();
  await expect(openSessions.getByText('Model: k2-thinking', { exact: true })).toBeVisible();
  await expect(openSessions.getByRole('button', { name: /^Autopilot/ })).toHaveCount(0);

  await openChat(page);
  await expect(page.getByRole('status', { name: 'Ready.' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Prompt' }).fill('/model ');
  const modelsMenu = page.getByRole('list', { name: 'Available models' });
  await expect(modelsMenu).toBeVisible();
  await expect(modelsMenu.getByText('k2-thinking')).toBeVisible();
  await expect(modelsMenu.getByText('k2-fast')).toBeVisible();
  await expect(modelsMenu.getByText('gpt-5.6-terra')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Autopilot/ })).toHaveCount(0);
});

test('hides the resume Copy action for kimi recent threads', async ({ page }) => {
  let recentOpenBody: unknown;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(bootstrap([], kimiProviders)),
    }),
  );
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'kimi-thread-1',
          cwd: '/project',
          recencyAt: 1784109600,
          provider: 'kimi',
          model: 'k2-thinking',
        },
        {
          id: 'codex-thread-1',
          cwd: '/other',
          recencyAt: 1784102400,
          resumeCommand: 'codex resume codex-thread-1',
        },
      ]),
    }),
  );
  await page.route('**/api/sessions', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/sessions/recent-threads/open', async (route) => {
    recentOpenBody = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'kimi-session-1',
        state: 'ready',
        workspacePath: '/project',
        provider: 'kimi',
        model: 'k2-thinking',
      }),
    });
  });
  await page.route('**/api/sessions/kimi-session-1/history', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(chatSnapshot()) }),
  );
  await page.route('**/api/sessions/kimi-session-1', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'kimi-session-1',
        state: 'ready',
        workspacePath: '/project',
        provider: 'kimi',
        model: 'k2-thinking',
      }),
    }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions' }).click();
  const recent = page.getByLabel('Recent sessions');
  await expect(recent.getByText('Kimi')).toBeVisible();
  await expect(recent.getByRole('button', { name: 'Copy' })).toHaveCount(1);
  await recent.getByRole('button', { name: 'Open' }).first().click();
  await expect
    .poll(() => recentOpenBody)
    .toEqual({
      threadId: 'kimi-thread-1',
      cwd: '/project',
      provider: 'kimi',
    });
});
