/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

test.beforeEach(async ({ page }) => mockAuthenticatedStatus(page));

type BootstrapWorkspace = {
  id: string;
  name: string;
  relativePath: string;
  isGitRepository: boolean;
  children: BootstrapWorkspace[];
};

function workspaceTree(children: BootstrapWorkspace[] = []): BootstrapWorkspace[] {
  return [
    {
      id: 'workspace-1',
      name: 'project',
      relativePath: '.',
      isGitRepository: false,
      children,
    },
  ];
}

function workspaceNode(
  id: string,
  name: string,
  children: BootstrapWorkspace[] = [],
  isGitRepository = false,
): BootstrapWorkspace {
  return { id, name, relativePath: name, isGitRepository, children };
}

async function openChat(page: Page): Promise<void> {
  const chat = page.getByRole('button', { name: 'Chat' });
  await expect(chat).toBeEnabled();
  await chat.click();
  await expect(page.getByRole('button', { name: 'Chat', pressed: true })).toBeVisible();
}

test('starts a selected workspace session and opens chat', async ({ page }) => {
  let historyReads = 0;
  const session = {
    id: 'session-1',
    threadId: 'codex-thread-1',
    state: 'ready',
    workspaceId: 'workspace-1',
    profile: 'work',
    activeTurnId: null,
  };
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [],
      }),
    }),
  );
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({
        workspaceId: 'workspace-1',
        profile: 'default',
        model: 'gpt-5.6-terra',
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
      });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(session) });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([session]) });
  });
  await page.route('**/api/sessions/session-1/turns', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ text: 'Inspect this workspace' });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ activeTurnId: 'turn-1' }),
    });
  });
  await page.route('**/api/sessions/session-1/history', (route) => {
    historyReads += 1;
    if (historyReads === 1)
      return route.fulfill({
        status: 502,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          code: 'SESSION_HISTORY_READ_FAILED',
          detail: 'History is not ready yet.',
          retryable: true,
        }),
      });
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(chatSnapshot()),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByLabel('Approval policy').selectOption({ label: 'Ask out of workspace' });
  await page.getByRole('button', { name: 'Create session' }).click();

  await expect(page.getByRole('button', { name: 'Chat', pressed: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
  await expect.poll(() => historyReads).toBeGreaterThanOrEqual(2);
  await expect(page.getByLabel('Notifications')).not.toContainText(
    'Session history could not be read',
  );
  await expect(page.getByText('Agents (1)')).toBeVisible();
  await page.getByText('Agents (1)').click();
  await expect(page.getByLabel('Agent activity')).toContainText('Root agent');
  await expect(page.getByLabel('Agent activity')).toContainText('activity unavailable');
  await page.getByText('Agents (1)').click();
  await page.getByRole('textbox', { name: 'Prompt' }).fill('Inspect this workspace');
  await page.getByRole('textbox', { name: 'Prompt' }).press('Enter');
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue(
    'Inspect this workspace\n',
  );
  await expect(page.getByText('Inspect this workspace')).not.toBeVisible();
  await page.getByRole('textbox', { name: 'Prompt' }).fill('Inspect this workspace');
  await page.getByRole('textbox', { name: 'Prompt' }).press('Control+Enter');
  await expect(page.getByText('Inspect this workspace')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Interrupt' })).toBeVisible();
});

test('sends a selected named skill profile only when creating a new session', async ({ page }) => {
  let requestBody: unknown;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [],
      }),
    }),
  );
  await page.route('**/api/skill-profiles', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        profiles: [{ version: 1, name: 'focused', path: '/profiles/focused.yml', skills: [] }],
      }),
    }),
  );
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() === 'POST') {
      requestBody = route.request().postDataJSON();
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ id: 'session-1', state: 'ready' }),
      });
    }
    return route.fulfill({ contentType: 'application/json', body: '[]' });
  });

  await page.goto('/');
  await page.getByLabel('Skills profile').selectOption('focused');
  await page.getByRole('button', { name: 'Create session' }).click();
  await expect
    .poll(() => requestBody)
    .toEqual({
      workspaceId: 'workspace-1',
      profile: 'default',
      model: 'gpt-5.6-terra',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      skillProfile: 'focused',
    });
});

test('labels relay threads as sessions and shows recent sessions from Codex', async ({ page }) => {
  const managedSession = {
    id: 'relay-session-1',
    state: 'ready',
    threadId: 'relay-thread-id',
    workspaceId: 'workspace-1',
    workspacePath: '/projects/relay',
    profile: 'work',
    updatedAt: '2026-07-15T10:00:00.000Z',
  };
  const promotedSession = {
    ...managedSession,
    id: 'promoted-session-1',
    threadId: 'recent-thread-id',
    workspacePath: '/projects/from-ssh',
  };
  let recentOpened = false;
  await page.addInitScript(() => {
    Date.now = () => Date.UTC(2026, 6, 15, 12, 0, 0);
  });
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [managedSession],
      }),
    }),
  );
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'recent-thread-id',
          cwd: '/projects/from-ssh',
          recencyAt: 1784109600,
          resumeCommand: 'codex-profile cli work resume recent-thread-id',
        },
        {
          id: 'relay-thread-id',
          cwd: '/projects/relay',
          recencyAt: 1784102400,
          resumeCommand: 'codex-profile cli work resume relay-thread-id',
        },
      ]),
    }),
  );
  await page.route('**/api/sessions/relay-session-1/history', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(chatSnapshot()) }),
  );
  await page.route('**/api/sessions/promoted-session-1/history', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(chatSnapshot()) }),
  );
  await page.route('**/api/sessions/recent-threads/open', async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      threadId: 'recent-thread-id',
      cwd: '/projects/from-ssh',
    });
    recentOpened = true;
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify(promotedSession),
    });
  });
  await page.route('**/api/sessions', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(recentOpened ? [promotedSession, managedSession] : [managedSession]),
    }),
  );

  await page.goto('/');
  await expect(page.getByLabel('Primary').getByRole('button')).toHaveText([
    'Sessions',
    'Git',
    'Chat',
    'Plan',
  ]);
  await page.getByRole('button', { name: 'Sessions' }).click();

  await expect(page.getByRole('heading', { name: 'Open sessions' })).toBeVisible();
  await expect(page.getByLabel('Open sessions').getByText('/projects/relay')).toBeVisible();
  await expect(page.getByLabel('Open sessions').getByText('relay-thread-id')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Recent sessions' })).toBeVisible();
  await expect(page.getByLabel('Recent sessions').getByText('2 hours ago')).toBeVisible();
  await expect(page.getByLabel('Recent sessions').getByText('/projects/from-ssh')).toBeVisible();
  await expect(page.getByLabel('Recent sessions').getByText('recent-thread-id')).toHaveCount(0);
  await expect(
    page.getByLabel('Recent sessions').getByRole('button', { name: 'Copy' }),
  ).toHaveCount(1);

  await expect(page.getByLabel('Open sessions').getByRole('button', { name: 'Open' })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page
    .getByLabel('Recent sessions')
    .getByRole('listitem')
    .filter({ hasText: '/projects/from-ssh' })
    .getByRole('button', { name: 'Open' })
    .click();
  await expect.poll(() => recentOpened).toBe(true);
  await expect(page.getByRole('button', { name: 'Chat', pressed: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
  await page.getByRole('button', { name: 'Sessions' }).click();
  await expect(page.getByLabel('Open sessions').getByText('/projects/from-ssh')).toBeVisible();
});

test('separates open and saved sessions and retains forgotten threads in recent history', async ({
  page,
}) => {
  const sessions = [
    {
      id: 'running-session',
      state: 'ready',
      threadId: 'running-thread',
      workspacePath: '/projects/running',
      profile: 'work',
      resumeCommand: 'codex resume running-thread',
    },
    {
      id: 'stopped-session',
      state: 'released',
      threadId: 'stopped-thread',
      workspacePath: '/projects/stopped',
      profile: 'work',
      resumeCommand: 'codex resume stopped-thread',
    },
  ];
  let closed = false;
  let forgotten = false;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions,
      }),
    }),
  );
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/sessions/stopped-session', async (route) => {
    expect(route.request().method()).toBe('DELETE');
    forgotten = true;
    await route.fulfill({ status: 204 });
  });
  await page.route('**/api/sessions/running-session/release', async (route) => {
    expect(route.request().method()).toBe('POST');
    closed = true;
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ ...sessions[0], state: 'released' }),
    });
  });
  await page.route('**/api/sessions', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        (closed ? [{ ...sessions[0], state: 'released' }, sessions[1]] : sessions).filter(
          (session) => !forgotten || session.id !== 'stopped-session',
        ),
      ),
    }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions' }).click();

  const openSessions = page.getByLabel('Open sessions');
  const savedSessions = page.getByLabel('Saved sessions');
  await expect(openSessions.getByRole('listitem')).toHaveCount(1);
  await expect(openSessions.getByRole('button', { name: 'Open' })).toHaveCount(0);
  await expect(openSessions.getByRole('button', { name: 'Close' })).toHaveCount(1);
  await expect(openSessions.getByRole('button', { name: 'Copy', exact: true })).toHaveCount(1);
  await expect(openSessions.getByRole('button', { name: 'Forget' })).toHaveCount(0);
  await expect(savedSessions.getByRole('listitem')).toHaveCount(1);
  await expect(savedSessions.getByRole('button', { name: 'Copy', exact: true })).toHaveCount(1);
  await expect(savedSessions.getByRole('button', { name: 'Open' })).toHaveCount(1);
  await expect(savedSessions.getByRole('button', { name: 'Forget' })).toHaveCount(1);

  await savedSessions.getByRole('button', { name: 'Forget' }).click();
  await expect.poll(() => forgotten).toBe(true);
  await expect(savedSessions.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByLabel('Recent sessions').getByText('/projects/stopped')).toBeVisible();

  await openSessions.getByRole('button', { name: 'Close' }).click();
  await expect.poll(() => closed).toBe(true);
  await expect(page.getByRole('heading', { name: 'Open sessions' })).toHaveCount(0);
  await expect(savedSessions.getByRole('listitem')).toHaveCount(1);

  await savedSessions
    .getByRole('listitem')
    .filter({ hasText: '/projects/running' })
    .getByRole('button', { name: 'Open' })
    .click();
  await expect(page.getByRole('button', { name: 'Chat', pressed: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sessions' }).click();
  await expect(savedSessions.getByText('/projects/running')).toBeVisible();
});

test('Open selects detached history without restoring a replacement session at mobile and desktop sizes', async ({
  page,
}) => {
  const saved = {
    id: 'saved-session',
    state: 'released',
    threadId: 'missing-thread',
    workspacePath: '/projects/saved',
    workspaceId: 'workspace-1',
    profile: 'work',
    activeTurnId: null,
  };
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [saved],
      }),
    }),
  );
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/sessions', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([saved]),
    }),
  );
  let restoreRequests = 0;
  await page.route('**/api/sessions/saved-session/restore', async (route) => {
    restoreRequests += 1;
    await route.fulfill({ status: 500 });
  });
  await page.route('**/api/sessions/saved-session/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(chatSnapshot()),
    }),
  );

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByRole('button', { name: 'Sessions' }).click();
    await page.getByLabel('Saved sessions').getByRole('button', { name: 'Open' }).click();
    await expect(page.getByRole('button', { name: 'Chat', pressed: true })).toBeVisible();
    await expect(
      page.getByText('You can read this conversation. Sending will connect to Codex.'),
    ).toBeVisible();
  }
  expect(restoreRequests).toBe(0);
});

test('Open hydrates a saved session without a restore request', async ({ page }) => {
  const saved = {
    id: 'retry-session',
    state: 'released',
    threadId: 'old-thread',
    workspacePath: '/projects/retry',
    workspaceId: 'workspace-1',
    profile: 'work',
    activeTurnId: null,
  };
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [saved],
      }),
    }),
  );
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/sessions', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify([saved]) }),
  );
  let restoreRequests = 0;
  await page.route('**/api/sessions/retry-session/restore', async (route) => {
    restoreRequests += 1;
    await route.fulfill({ status: 500 });
  });
  await page.route('**/api/sessions/retry-session/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(chatSnapshot()),
    }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions' }).click();
  const open = page.getByLabel('Saved sessions').getByRole('button', { name: 'Open' });
  await open.click();
  await expect(page.getByRole('button', { name: 'Chat', pressed: true })).toBeVisible();
  expect(restoreRequests).toBe(0);
});

test('starts a session with sandbox and approval settings', async ({ page }) => {
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [],
      }),
    }),
  );
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify([]) });
      return;
    }
    expect(route.request().postDataJSON()).toEqual({
      workspaceId: 'workspace-1',
      profile: 'default',
      model: 'gpt-5.6-terra',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    });
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'session-1', state: 'ready' }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByLabel('Sandbox').selectOption('workspace-write');
  await page.getByLabel('Approval policy').selectOption('never');
  await expect(page.getByLabel('Model')).toHaveValue('gpt-5.6-terra');
  await page.getByRole('button', { name: 'Create session' }).click();
  await expect(page.getByRole('button', { name: 'Chat', pressed: true })).toBeVisible();
});

test('rehydrates a durable pending interaction after a browser reload', async ({ page }) => {
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [
          {
            id: 'session-1',
            state: 'ready',
            workspaceId: 'workspace-1',
            profile: 'work',
            pendingInteractions: [
              { requestId: 'approval-1', kind: 'commandApproval', payload: {} },
            ],
          },
        ],
      }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        chatSnapshot({
          interactions: [
            {
              requestId: 'approval-1',
              kind: 'commandApproval',
              turnId: null,
              requestedAt: '2026-01-01T00:00:00.000Z',
              resolvedAt: null,
              payload: {},
            },
          ],
        }),
      ),
    }),
  );

  await page.goto('/');

  await openChat(page);
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
});

test('shows a start-session failure and permits a retry', async ({ page }) => {
  const repositoryId = 'opaque:group/repository%leaf';
  const intermediateId = 'opaque:group';
  const requestedWorkspaceIds: string[] = [];
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree([
          workspaceNode(intermediateId, 'group', [
            workspaceNode(repositoryId, 'repository', [], true),
          ]),
        ]),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [],
      }),
    }),
  );
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ contentType: 'application/json', body: '[]' });
      return;
    }
    requestedWorkspaceIds.push(
      (route.request().postDataJSON() as { workspaceId: string }).workspaceId,
    );
    if (requestedWorkspaceIds.length === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        body: JSON.stringify({ detail: 'Codex app-server is unavailable.' }),
      });
      return;
    }
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'session-1', state: 'ready' }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions' }).click();
  await expect(page.getByLabel('Workspace')).toHaveCount(0);
  const repository = page.getByRole('treeitem', { name: /^repository/ });
  await repository.click();
  await expect(repository).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Create session' }).click();

  await expect(page.getByRole('button', { name: 'Create session' })).toBeEnabled();
  await expect(repository).toHaveAttribute('aria-selected', 'true');
  const intermediate = page.getByRole('treeitem', { name: /^group/ });
  await intermediate.click();
  await expect(intermediate).toHaveAttribute('aria-selected', 'true');
  await expect(repository).toHaveAttribute('aria-selected', 'false');
  await page.getByRole('button', { name: 'Create session' }).click();

  await expect.poll(() => requestedWorkspaceIds).toEqual([repositoryId, intermediateId]);
  await expect(page.getByRole('button', { name: 'Chat', pressed: true })).toBeVisible();
});

test('keeps the composer reachable at a phone viewport without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const session = {
    id: 'session-1',
    state: 'ready',
    workspaceId: 'workspace-1',
    profile: 'work',
    activeTurnId: null,
  };
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [session],
      }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(chatSnapshot()),
    }),
  );

  await page.goto('/');

  await openChat(page);
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
  const ready = page.getByRole('status', { name: 'Ready.' });
  expect(
    await ready.evaluate((element) => parseFloat(getComputedStyle(element).marginTop)),
  ).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('keeps active-session glass chrome on one row at 320px with 200% text', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const session = {
    id: 'session-1',
    state: 'ready',
    workspaceId: 'workspace-1',
    workspacePath: '/projects/a-very-long-active-workspace-name',
    model: 'gpt-5.6-terra',
    profile: 'work',
    activeTurnId: null,
  };
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [session],
      }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        chatSnapshot({
          items: Array.from({ length: 20 }, (_, index) => ({
            id: `message-${index}`,
            kind: index % 2 === 0 ? 'user' : 'agent',
            text: `Scrollable message ${index}`,
            occurredAt: index,
          })),
        }),
      ),
    }),
  );

  await page.goto('/');
  await page.locator('html').evaluate((root) => (root.style.fontSize = '200%'));
  await openChat(page);
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight }));

  const layout = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('.app-header')!;
    const headerChildren = [...header.children]
      .filter((element) => !element.hasAttribute('popover'))
      .map((element) => element.getBoundingClientRect());
    const navigation = document.querySelector<HTMLElement>('.bottom-navigation')!;
    const navigationButtons = [...navigation.querySelectorAll('button')].map((button) =>
      button.getBoundingClientRect(),
    );
    const centers = headerChildren.map(({ top, height }) => top + height / 2);
    const viewportWidth = document.documentElement.clientWidth;
    const headerBox = header.getBoundingClientRect();
    return {
      headerFits: headerChildren.every(
        ({ left, right }) => left >= -0.5 && right <= viewportWidth + 0.5,
      ),
      navigationFits: navigationButtons.every(
        ({ left, right }) => left >= -0.5 && right <= viewportWidth + 0.5,
      ),
      headerTop: header.getBoundingClientRect().top,
      headerFullWidth:
        Math.abs(headerBox.left) <= 0.5 && Math.abs(headerBox.right - viewportWidth) <= 0.5,
      headerOneRow: Math.max(...centers) - Math.min(...centers) <= 1,
      navigationOneRow:
        Math.max(...navigationButtons.map(({ top }) => top)) -
          Math.min(...navigationButtons.map(({ top }) => top)) <=
        1,
    };
  });
  expect(layout).toEqual({
    headerFits: true,
    navigationFits: true,
    headerTop: 0,
    headerFullWidth: true,
    headerOneRow: true,
    navigationOneRow: true,
  });
});

test('keeps the session controls within a 320px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [],
      }),
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions' }).click();
  await expect(page.getByRole('button', { name: 'Create session' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('switches Git operations between repository tree targets without a session', async ({
  page,
}) => {
  const summary = {
    available: true,
    branch: 'main',
    branches: ['main', 'topic'],
    upstream: 'origin/main',
    ahead: 2,
    behind: 0,
    dirty: { staged: 1, unstaged: 0, untracked: 0 },
    commits: [],
    fetchedAt: '2026-07-14T10:00:00.000Z',
  };
  const branches = new Map([
    ['repo-one', 'main'],
    ['repo-two', 'topic'],
  ]);
  const summaryTargets: string[] = [];
  const actionTargets: Array<{ action: string; id: string }> = [];
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree([
          workspaceNode('repo-one', 'alpha', [], true),
          workspaceNode('repo-two', 'beta', [], true),
          workspaceNode('ordinary', 'clones'),
        ]),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [],
      }),
    }),
  );
  await page.route(/\/api\/git\/repositories\/(repo-one|repo-two)$/, (route) => {
    const id = route.request().url().split('/').at(-1)!;
    summaryTargets.push(id);
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ...summary, branch: branches.get(id) }),
    });
  });
  await page.route(/\/api\/git\/repositories\/(repo-one|repo-two)\/checkout$/, async (route) => {
    const id = route.request().url().split('/').at(-2)!;
    branches.set(id, (route.request().postDataJSON() as { branch: string }).branch);
    actionTargets.push({ action: 'checkout', id });
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
  });
  await page.route(/\/api\/git\/repositories\/(repo-one|repo-two)\/pull$/, async (route) => {
    actionTargets.push({ action: 'pull', id: route.request().url().split('/').at(-2)! });
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
  });
  await page.route(/\/api\/git\/repositories\/(repo-one|repo-two)\/push$/, async (route) => {
    actionTargets.push({ action: 'push', id: route.request().url().split('/').at(-2)! });
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Git' }).click();

  await page.getByRole('treeitem', { name: /^alpha/ }).click();
  await expect(page.getByLabel('Branch')).toHaveValue('main');
  await page.getByRole('treeitem', { name: /^beta/ }).click();
  await expect(page.getByLabel('Branch')).toHaveValue('topic');
  await expect(page.getByText('Upstream: origin/main')).toBeVisible();
  await page.getByRole('button', { name: 'Pull' }).click();
  await expect(page.getByRole('button', { name: 'Push' })).toBeEnabled();
  await page.getByRole('button', { name: 'Push' }).click();
  await expect(page.getByText('Push HEAD to origin/main?')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm push' }).click();
  await page.getByLabel('Branch').selectOption('main');
  await expect.poll(() => branches.get('repo-two')).toBe('main');
  await expect(page.getByLabel('Branch')).toHaveValue('main');
  expect(summaryTargets).toEqual(expect.arrayContaining(['repo-one', 'repo-two']));
  expect(actionTargets).toEqual(
    expect.arrayContaining([
      { action: 'pull', id: 'repo-two' },
      { action: 'push', id: 'repo-two' },
      { action: 'checkout', id: 'repo-two' },
    ]),
  );

  await page.getByRole('treeitem', { name: /^clones/ }).click();
  await expect(page.getByLabel('Branch')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Push' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Pull' })).toBeDisabled();
  await expect(page.getByText(/available as a Clone destination/)).toBeVisible();
});

test('refreshes and selects the catalog after a successful clone', async ({ page }) => {
  let cloneRequest: { workspaceId: string; address: string } | null = null;
  let bootstrapReads = 0;
  await page.route('**/api/bootstrap', (route) => {
    bootstrapReads += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree([
          workspaceNode(
            'workspace-2',
            'archive',
            bootstrapReads > 1 ? [workspaceNode('cloned-repository', 'cloned-repo', [], true)] : [],
          ),
        ]),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [],
      }),
    });
  });
  await page.route('**/api/git/repositories/cloned-repository', (route) =>
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
        commits: [],
        fetchedAt: null,
      }),
    }),
  );
  await page.route('**/api/git/clone', async (route) => {
    cloneRequest = route.request().postDataJSON() as { workspaceId: string; address: string };
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Git' }).click();
  await page.getByRole('treeitem', { name: /^archive/ }).click();
  await page.getByLabel('Git address').fill('https://example.test/cloned-repo.git');
  await page.getByRole('button', { name: 'Clone' }).click();

  await expect
    .poll(() => cloneRequest)
    .toEqual({
      workspaceId: 'workspace-2',
      address: 'https://example.test/cloned-repo.git',
    });
  await expect(page.getByRole('status').filter({ hasText: 'selected workspace' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /^cloned-repo/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByLabel('Git address')).toHaveValue('https://example.test/cloned-repo.git');
});

test('explains and dismisses invalid clone destinations without a relay request', async ({
  page,
}) => {
  let cloneRequests = 0;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree([workspaceNode('repository', 'repository', [], true)]),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
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
        commits: [],
        fetchedAt: null,
      }),
    }),
  );
  await page.route('**/api/git/clone', async (route) => {
    cloneRequests += 1;
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Git' }).click();
  await page.getByLabel('Git address').fill('https://example.test/repository.git');
  await page.getByRole('button', { name: 'Clone' }).click();
  const noSelectionAlert = page.getByRole('alert').filter({
    hasText: 'Select a non-repository folder before cloning.',
  });
  await expect(noSelectionAlert).toBeVisible();
  expect(cloneRequests).toBe(0);
  await noSelectionAlert.getByRole('button', { name: 'Dismiss error notification' }).click();
  await expect(noSelectionAlert).toBeHidden();

  await page.getByRole('treeitem', { name: /^repository/ }).click();
  await page.getByRole('button', { name: 'Clone' }).click();
  await expect(
    page.getByRole('alert').filter({
      hasText: 'Select a non-repository folder before cloning.',
    }),
  ).toBeVisible();
  expect(cloneRequests).toBe(0);
});

test('prevents duplicate clone requests and preserves the address after relay failure', async ({
  page,
}) => {
  let cloneRequests = 0;
  let completeClone: (() => void) | undefined;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree([workspaceNode('destination', 'destination')]),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [],
      }),
    }),
  );
  await page.route('**/api/git/clone', async (route) => {
    cloneRequests += 1;
    await new Promise<void>((resolve) => {
      completeClone = resolve;
    });
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'INTERNAL_ERROR' }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Git' }).click();
  await page.getByRole('treeitem', { name: /^destination/ }).click();
  const address = page.getByLabel('Git address');
  await address.fill('https://example.test/retry-me.git');
  const clone = page.getByRole('button', { name: 'Clone' });
  await clone.click();
  await expect(page.getByRole('button', { name: 'Cloning…' })).toBeDisabled();
  await page.getByRole('button', { name: 'Cloning…' }).evaluate((button) => button.click());
  expect(cloneRequests).toBe(1);
  completeClone?.();
  await expect(
    page.getByLabel('Notifications').getByRole('alert').filter({ hasText: 'Clone failed.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Repository details' }).getByRole('alert'),
  ).toHaveCount(0);
  await expect(address).toHaveValue('https://example.test/retry-me.git');
  await expect(clone).toBeEnabled();
  expect(cloneRequests).toBe(1);
});

test('keeps Sessions and Git selections independent through a successful clone refresh', async ({
  page,
}) => {
  const repositoryId = 'opaque:group/repository%leaf';
  const intermediateId = 'opaque:group';
  let bootstrapReads = 0;
  await page.route('**/api/bootstrap', (route) => {
    bootstrapReads += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree([
          workspaceNode(intermediateId, 'group', [
            workspaceNode(repositoryId, 'repository', [], true),
            ...(bootstrapReads > 1 ? [workspaceNode('opaque:new', 'new-folder')] : []),
          ]),
        ]),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [],
      }),
    });
  });
  await page.route('**/api/git/clone', (route) =>
    route.fulfill({ status: 202, contentType: 'application/json', body: '{}' }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions' }).click();
  const repository = page.getByRole('treeitem', { name: /^repository/ });
  await repository.click();
  await expect(repository).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'Git' }).click();
  await page.getByRole('treeitem', { name: /^group/ }).click();
  await page.getByLabel('Git address').fill('https://example.test/new.git');
  await page.getByRole('button', { name: 'Clone' }).click();
  await expect.poll(() => bootstrapReads).toBe(2);

  await page.getByRole('button', { name: 'Sessions' }).click();
  await expect(page.getByRole('treeitem', { name: /^repository/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('treeitem', { name: /^new-folder/ })).toBeVisible();
});

test('hydrates canonical history for a persisted session', async ({ page }) => {
  const session = {
    id: 'session-1',
    state: 'ready',
    workspaceId: 'workspace-1',
    profile: 'work',
    activeTurnId: null,
  };
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [session],
      }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        baseSequence: 7,
        currentSequence: 7,
        activeTurnId: 'terminal-turn-1',
        items: [
          { id: 'user-1', kind: 'user', text: 'Check the branch' },
          {
            id: 'commentary-1',
            kind: 'agent',
            phase: 'commentary',
            text: 'I am inspecting the branch.',
          },
          { id: 'commentary-2', kind: 'agent', phase: 'commentary', text: 'The branch is clean.' },
          {
            id: 'answer-1',
            kind: 'agent',
            phase: 'final_answer',
            occurredAt: Date.parse('2026-07-15T10:00:00.000Z'),
            text: 'No changes are needed.\n\nInstallation | What it receives\n|---|---|\n| `npx skills add` | Only `my-skill/` |',
          },
          { id: 'command-1', kind: 'command', command: 'git status', status: 'completed' },
        ],
        turns: [],
        interactions: [],
      }),
    }),
  );

  await page.goto('/');

  await openChat(page);
  await expect(page.getByText('Check the branch')).toBeVisible();
  await expect(page.getByText('working', { exact: true })).toBeVisible();
  await expect(page.getByText('No changes are needed.')).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Installation' })).toBeVisible();
  await expect(page.getByText('npx skills add')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Interrupt' })).toBeVisible();
  const messageList = page.getByRole('list', { name: 'Chat messages' });
  const promptTurn = messageList.locator('.prompt-turn');
  const answerTurn = messageList
    .locator('.answer-item')
    .filter({ hasText: 'No changes are needed.' });
  await expect(messageList).toHaveCSS('padding-left', '0px');
  await expect(promptTurn).toHaveCSS(
    'width',
    await messageList.evaluate((element) => `${element.clientWidth}px`),
  );
  expect(
    await promptTurn.evaluate((element) => getComputedStyle(element).backgroundColor),
  ).not.toBe(await answerTurn.evaluate((element) => getComputedStyle(element).backgroundColor));
  await expect(page.getByRole('button', { name: 'Send prompt' }).locator('svg')).toBeVisible();
  const answerHeading = answerTurn.locator('.answer-turn .entry-heading');
  expect(
    await answerHeading
      .locator(':scope > *')
      .evaluateAll((elements) => elements.map((element) => element.tagName)),
  ).toEqual(['STRONG', 'TIME']);
  await expect(messageList.getByText('I am inspecting the branch.')).toBeVisible();
  await expect(messageList.getByText('The branch is clean.')).toBeVisible();
  await expect(messageList.locator('.live-activity')).toContainText('Command · completed');
  await expect(messageList.locator('details')).toHaveCount(0);
});

test('reconciles terminal-originated history while Chat is visible', async ({ page }) => {
  const session = {
    id: 'session-1',
    state: 'ready',
    workspaceId: 'workspace-1',
    profile: 'work',
    activeTurnId: null,
  };
  let reads = 0;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [session],
      }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) => {
    reads += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        baseSequence: reads,
        currentSequence: reads,
        activeTurnId: null,
        items:
          reads === 1
            ? [{ id: 'user-1', kind: 'user', text: 'Initial message' }]
            : [
                { id: 'user-1', kind: 'user', text: 'Initial message' },
                { id: 'user-2', kind: 'user', text: 'Message from terminal' },
                {
                  id: 'answer-2',
                  kind: 'agent',
                  phase: 'final_answer',
                  text: 'Terminal answer',
                },
              ],
        turns: [],
        interactions: [],
      }),
    });
  });

  await page.goto('/');

  await openChat(page);
  await expect(page.getByText('Initial message')).toBeVisible();
  await expect(page.getByText('Message from terminal')).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText('Terminal answer')).toBeVisible();
});

test('shows Git pull progress and disables push without an upstream', async ({ page }) => {
  let completeRefresh: (() => void) | undefined;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree([workspaceNode('repo-one', 'repository', [], true)]),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [],
      }),
    }),
  );
  await page.route('**/api/git/repositories/repo-one', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        available: true,
        branch: 'topic',
        branches: ['main', 'topic'],
        upstream: null,
        ahead: 1,
        behind: 0,
        dirty: { staged: 0, unstaged: 0, untracked: 0 },
        commits: [],
        fetchedAt: null,
      }),
    }),
  );
  await page.route('**/api/git/repositories/repo-one/pull', async (route) => {
    await new Promise<void>((resolve) => {
      completeRefresh = resolve;
    });
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Git' }).click();
  await page.getByRole('treeitem', { name: /^repository/ }).click();
  await expect(page.getByRole('button', { name: 'Push' })).toBeDisabled();
  await page.getByRole('button', { name: 'Pull' }).click();
  await expect(page.getByRole('button', { name: 'Pulling…' })).toBeDisabled();
  completeRefresh?.();
  await expect(page.getByRole('button', { name: 'Pull' })).toBeEnabled();
});

test('renders and resolves a relay approval request', async ({ page }) => {
  const session = {
    id: 'session-1',
    state: 'ready',
    workspaceId: 'workspace-1',
    profile: 'work',
    activeTurnId: 'turn-1',
  };
  let response: unknown;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [session],
      }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        chatSnapshot({
          activeTurnId: 'turn-1',
          interactions: [
            {
              requestId: 'request-1',
              kind: 'commandApproval',
              turnId: 'turn-1',
              requestedAt: '2026-01-01T00:00:00.000Z',
              resolvedAt: null,
              payload: {},
            },
          ],
        }),
      ),
    }),
  );
  await page.route('**/api/sessions/session-1/interactions/request-1', async (route) => {
    response = route.request().postDataJSON();
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
  });
  await page.routeWebSocket(
    /ws:\/\/127\.0\.0\.1:4173\/api\/sessions\/session-1\/events\?after=\d+/,
    (socket) => {
      socket.send(
        JSON.stringify({
          type: 'relay.event',
          event: {
            sequence: 1,
            type: 'interaction.requested',
            payload: { requestId: 'request-1', kind: 'commandApproval', payload: {} },
          },
        }),
      );
    },
  );

  await page.goto('/');
  await openChat(page);
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => response).toEqual({ decision: 'accept' });
});

test('answers a relay user-input request', async ({ page }) => {
  const session = {
    id: 'session-1',
    state: 'ready',
    workspaceId: 'workspace-1',
    profile: 'work',
    activeTurnId: 'turn-1',
  };
  let response: unknown;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [session],
      }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        chatSnapshot({
          activeTurnId: 'turn-1',
          interactions: [
            {
              requestId: 'request-1',
              kind: 'userInput',
              turnId: 'turn-1',
              requestedAt: '2026-01-01T00:00:00.000Z',
              resolvedAt: null,
              payload: {
                questions: [
                  {
                    id: 'question-1',
                    header: 'Mode',
                    question: 'Choose a mode',
                    options: [{ label: 'Safe', description: 'Safe mode' }],
                  },
                ],
              },
            },
          ],
        }),
      ),
    }),
  );
  await page.route('**/api/sessions/session-1/interactions/request-1', async (route) => {
    response = route.request().postDataJSON();
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
  });
  await page.routeWebSocket(
    /ws:\/\/127\.0\.0\.1:4173\/api\/sessions\/session-1\/events\?after=\d+/,
    (socket) =>
      socket.send(
        JSON.stringify({
          type: 'relay.event',
          event: {
            sequence: 1,
            type: 'interaction.requested',
            payload: {
              requestId: 'request-1',
              kind: 'userInput',
              payload: {
                questions: [
                  {
                    id: 'question-1',
                    header: 'Mode',
                    question: 'Choose a mode',
                    options: [{ label: 'Safe', description: 'Safe mode' }],
                  },
                ],
              },
            },
          },
        }),
      ),
  );

  await page.goto('/');
  await openChat(page);
  await page.getByRole('radio', { name: /Safe/ }).check();
  await page.getByRole('button', { name: 'Send answers' }).click();
  await expect.poll(() => response).toEqual({ answers: { 'question-1': { answers: ['Safe'] } } });
});

test('projects a live agent delta from the relay socket', async ({ page }) => {
  const session = {
    id: 'session-1',
    state: 'turnActive',
    workspaceId: 'workspace-1',
    profile: 'work',
    activeTurnId: 'turn-1',
  };
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [session],
      }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(chatSnapshot({ activeTurnId: 'turn-1' })),
    }),
  );
  await page.routeWebSocket(
    'ws://127.0.0.1:4173/api/sessions/session-1/events?after=0',
    (socket) => {
      socket.send(
        JSON.stringify({
          type: 'relay.event',
          event: {
            sequence: 1,
            type: 'agentMessageDelta',
            payload: { text: 'Working on it.\nStill working.' },
          },
        }),
      );
    },
  );

  await page.goto('/');
  await openChat(page);
  await expect(page.getByText('working', { exact: true })).toBeVisible();
  await expect(page.getByText('Working on it.\nStill working.')).toBeVisible();
  await expect(page.locator('ol[aria-label="Chat messages"] li')).toHaveCSS(
    'white-space',
    'pre-wrap',
  );
});

test('projects a canonical activity from the Chat snapshot', async ({ page }) => {
  const session = {
    id: 'session-1',
    state: 'turnActive',
    workspaceId: 'workspace-1',
    profile: 'work',
    activeTurnId: 'turn-1',
  };
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [session],
      }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        chatSnapshot({
          activeTurnId: 'turn-1',
          items: [
            { id: 'commentary-1', kind: 'agent', phase: 'commentary', text: 'Inspecting.' },
            { id: 'item-1', kind: 'command', command: 'git status', status: 'completed' },
            {
              id: 'change-1',
              kind: 'fileChange',
              paths: ['src/app.ts', 'src/app.test.ts'],
              status: 'completed',
            },
          ],
        }),
      ),
    }),
  );

  await page.goto('/');
  await openChat(page);
  const activity = page.locator('.live-activity');
  await expect(activity.getByText('Command · completed')).toBeVisible();
  await expect(page.getByText('git status')).toBeVisible();
  const files = page.getByRole('region', { name: 'Files changed' });
  await expect(files).toContainText('src/app.ts');
  await expect(files).toContainText('src/app.test.ts');
  await expect(activity).not.toContainText('src/app.ts');
});

test('resynchronizes canonical history after a pruned relay cursor', async ({ page }) => {
  const session = {
    id: 'session-1',
    state: 'ready',
    workspaceId: 'workspace-1',
    profile: 'work',
    activeTurnId: null,
  };
  let reads = 0;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [session],
      }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) => {
    reads += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        baseSequence: 8,
        currentSequence: 8,
        activeTurnId: null,
        items: reads === 1 ? [] : [{ id: 'agent-1', kind: 'agent', text: 'Recovered history' }],
        turns: [],
        interactions: [],
      }),
    });
  });
  await page.routeWebSocket(
    /ws:\/\/127\.0\.0\.1:4173\/api\/sessions\/session-1\/events\?after=\d+/,
    (socket) => {
      socket.send(JSON.stringify({ type: 'relay.resyncRequired', currentSequence: 8 }));
    },
  );

  await page.goto('/');
  await openChat(page);
  await expect(page.getByText('Recovered history')).toBeVisible();
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
});

test('resynchronizes canonical history after a replay sequence gap', async ({ page }) => {
  const session = {
    id: 'session-1',
    state: 'ready',
    workspaceId: 'workspace-1',
    profile: 'work',
    activeTurnId: null,
  };
  let reads = 0;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [session],
      }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) => {
    reads += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        baseSequence: reads === 1 ? 0 : 3,
        currentSequence: reads === 1 ? 0 : 3,
        activeTurnId: null,
        items:
          reads === 1 ? [] : [{ id: 'agent-1', kind: 'agent', text: 'Recovered missing event' }],
        turns: [],
        interactions: [],
      }),
    });
  });
  await page.routeWebSocket(
    'ws://127.0.0.1:4173/api/sessions/session-1/events?after=0',
    (socket) => {
      socket.send(
        JSON.stringify({
          type: 'relay.event',
          event: { sequence: 2, type: 'agentMessageDelta', payload: { text: 'gapped' } },
        }),
      );
    },
  );

  await page.goto('/');
  await openChat(page);
  await expect(page.getByText('Recovered missing event')).toBeVisible();
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
});

test('reconnects a dropped browser socket and replays from its saved cursor', async ({ page }) => {
  const session = {
    id: 'session-1',
    state: 'turnActive',
    workspaceId: 'workspace-1',
    profile: 'work',
    activeTurnId: 'turn-1',
  };
  let connections = 0;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [session],
      }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(chatSnapshot({ activeTurnId: 'turn-1' })),
    }),
  );
  await page.routeWebSocket(
    /ws:\/\/127\.0\.0\.1:4173\/api\/sessions\/session-1\/events\?after=\d+/,
    (socket) => {
      connections += 1;
      if (connections === 1) {
        socket.send(
          JSON.stringify({
            type: 'relay.event',
            event: { sequence: 1, type: 'agentMessageDelta', payload: { text: 'before drop ' } },
          }),
        );
        socket.close();
      } else {
        socket.send(
          JSON.stringify({
            type: 'relay.event',
            event: { sequence: 2, type: 'agentMessageDelta', payload: { text: 'after replay' } },
          }),
        );
      }
    },
  );

  await page.goto('/');
  await openChat(page);
  await expect(page.getByText('working', { exact: true })).toBeVisible();
  await expect(page.getByText('before drop after replay')).toBeVisible();
  await expect.poll(() => connections).toBe(2);
  await expect(page.getByRole('status')).toHaveText('Codex is working…');
});

test('resynchronizes and reconnects after a relay restart closes its socket', async ({ page }) => {
  const session = {
    id: 'session-1',
    state: 'ready',
    workspaceId: 'workspace-1',
    profile: 'work',
    activeTurnId: null,
  };
  let reads = 0;
  let connections = 0;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [session],
      }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) => {
    reads += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        baseSequence: reads === 1 ? 0 : 4,
        currentSequence: reads === 1 ? 0 : 4,
        activeTurnId: null,
        items:
          reads === 1 ? [] : [{ id: 'restored', kind: 'agent', text: 'Restored after restart' }],
        turns: [],
        interactions: [],
      }),
    });
  });
  await page.routeWebSocket(
    /ws:\/\/127\.0\.0\.1:4173\/api\/sessions\/session-1\/events\?after=\d+/,
    (socket) => {
      connections += 1;
      if (connections === 1) {
        socket.send(JSON.stringify({ type: 'relay.resyncRequired', currentSequence: 4 }));
        socket.close();
      } else {
        socket.send(
          JSON.stringify({
            type: 'relay.event',
            event: { sequence: 5, type: 'agentMessageDelta', payload: { text: 'live again' } },
          }),
        );
      }
    },
  );

  await page.goto('/');

  await openChat(page);
  await expect(page.getByText('Restored after restart')).toBeVisible();
  await expect(page.getByText('live again')).toBeVisible();
  await expect.poll(() => connections).toBe(2);
  await expect(page.getByRole('status')).toHaveText('Ready');
});

test('clears an interrupted active turn when relay recovery updates the session', async ({
  page,
}) => {
  const session = {
    id: 'session-1',
    state: 'turnActive',
    workspaceId: 'workspace-1',
    profile: 'work',
    activeTurnId: 'turn-1',
  };
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [session],
      }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(chatSnapshot()),
    }),
  );
  await page.routeWebSocket(
    'ws://127.0.0.1:4173/api/sessions/session-1/events?after=0',
    (socket) => {
      socket.send(
        JSON.stringify({
          type: 'relay.event',
          event: {
            sequence: 1,
            type: 'session.updated',
            payload: { ...session, state: 'ready', activeTurnId: null },
          },
        }),
      );
    },
  );

  await page.goto('/');

  await openChat(page);
  await expect(page.getByRole('button', { name: 'Interrupt' })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Prompt' }).fill('Continue after recovery');
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
});

test('switches primary navigation with arrow keys', async ({ page }) => {
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: [], profiles: [], sessions: [] }),
    }),
  );

  await page.goto('/');
  const sessions = page.getByRole('button', { name: 'Sessions', pressed: true });
  await expect(page.getByRole('button', { name: 'Chat' })).toBeDisabled();
  await expect(sessions).toHaveCSS('font-weight', '700');
  await sessions.press('ArrowRight');
  const git = page.getByRole('button', { name: 'Git', pressed: true });
  await expect(git).toHaveCSS('font-weight', '700');
  await expect(git).toBeFocused();
  await git.press('ArrowRight');
  const plan = page.getByRole('button', { name: 'Plan', pressed: true });
  await expect(plan).toHaveCSS('font-weight', '700');
  await expect(plan).toBeFocused();
  await plan.press('ArrowRight');
  const selectedSessions = page.getByRole('button', { name: 'Sessions', pressed: true });
  await expect(selectedSessions).toHaveCSS('font-weight', '700');
  await expect(selectedSessions).toBeFocused();
  await selectedSessions.press('ArrowRight');
  const selectedGit = page.getByRole('button', { name: 'Git', pressed: true });
  await expect(selectedGit).toHaveCSS('font-weight', '700');
  await expect(selectedGit).toBeFocused();
  await selectedGit.press('ArrowLeft');
  await expect(page.getByRole('button', { name: 'Sessions', pressed: true })).toBeFocused();
});

test('shows Gestalt branding and persists every named appearance from configuration', async ({
  page,
}) => {
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: [], profiles: [], sessions: [] }),
    }),
  );

  await page.goto('/');
  await expect(page).toHaveTitle('Gestalt Mobile');
  await expect(page.getByRole('link', { name: 'Gestalt Mobile' })).toBeVisible();

  for (const theme of ['dyne-org', 'minimal-light', 'minimal-dark']) {
    await page.getByRole('button', { name: 'Open configuration' }).click();
    await expect(page.locator('.configuration-brand')).toBeVisible();
    await page.getByLabel('Appearance').selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('gestalt-mobile.theme')))
      .toBe(theme);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  }
});

test('captures the configuration popover across the named theme accessibility matrix', async ({
  page,
}, testInfo: TestInfo) => {
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: [], profiles: [], sessions: [] }),
    }),
  );

  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
  ]) {
    for (const fontScale of [100, 200]) {
      for (const theme of ['dyne-org', 'minimal-light', 'minimal-dark']) {
        await page.setViewportSize(viewport);
        await page.goto('/');
        await page.locator('html').evaluate((root, scale) => {
          root.style.fontSize = `${scale}%`;
        }, fontScale);
        await page.getByRole('button', { name: 'Open configuration' }).click();
        await page.getByLabel('Appearance').selectOption(theme);
        const panel = page.locator('.configuration-panel');
        await expect(panel).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const viewportContainment = await panel.evaluate((element) => {
          const boxes = [element, ...element.querySelectorAll('select, button')].map(
            (candidate) => {
              const box = candidate.getBoundingClientRect();
              return { left: box.left, right: box.right };
            },
          );
          return {
            documentFits:
              document.documentElement.scrollWidth <= document.documentElement.clientWidth,
            panel: (() => {
              const box = element.getBoundingClientRect();
              return { top: box.top, bottom: box.bottom };
            })(),
            boxes,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
          };
        });
        expect(viewportContainment.documentFits, JSON.stringify(viewportContainment)).toBe(true);
        expect(
          viewportContainment.boxes.every(
            ({ left, right }) => left >= -0.5 && right <= viewportContainment.viewportWidth + 0.5,
          ),
          JSON.stringify(viewportContainment),
        ).toBe(true);
        expect(viewportContainment.panel.top).toBeGreaterThanOrEqual(-0.5);
        expect(viewportContainment.panel.bottom).toBeLessThanOrEqual(
          viewportContainment.viewportHeight + 0.5,
        );
        const lastAction = panel.getByRole('button', { name: 'Lock Gestalt Mobile' });
        await lastAction.scrollIntoViewIfNeeded();
        await expect(lastAction).toBeVisible();
        const lastActionBox = await lastAction.boundingBox();
        expect(lastActionBox).not.toBeNull();
        expect(lastActionBox!.y).toBeGreaterThanOrEqual(-0.5);
        expect(lastActionBox!.y + lastActionBox!.height).toBeLessThanOrEqual(
          viewportContainment.viewportHeight + 0.5,
        );
        expect(
          await page
            .getByRole('button', { name: 'Open configuration' })
            .evaluate((button) => button.getBoundingClientRect().height >= 44),
        ).toBe(true);
        await page.screenshot({
          path: testInfo.outputPath(
            `configuration-${viewport.width}x${viewport.height}-font${fontScale}-${theme}.png`,
          ),
        });
      }
    }
  }
});
