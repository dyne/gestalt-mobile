/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Page } from '@playwright/test';

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

  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByRole('button', { name: 'New session' }).click();

  await expect(page.getByRole('button', { name: 'Chat', pressed: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Prompt' }).fill('Inspect this workspace');
  await page.getByRole('textbox', { name: 'Prompt' }).press('Enter');
  await expect(page.getByText('Inspect this workspace')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Interrupt' })).toBeVisible();
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
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route('**/api/sessions/promoted-session-1/history', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
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

test('separates open and saved sessions and closes without forgetting', async ({ page }) => {
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
  let reopened = false;
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
  await page.route('**/api/sessions/running-session/release', async (route) => {
    expect(route.request().method()).toBe('POST');
    closed = true;
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ ...sessions[0], state: 'released' }),
    });
  });
  await page.route('**/api/sessions/running-session/restore', async (route) => {
    expect(route.request().method()).toBe('POST');
    reopened = true;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(sessions[0]),
    });
  });
  await page.route('**/api/sessions', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        closed && !reopened ? [{ ...sessions[0], state: 'released' }, sessions[1]] : sessions,
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
  await expect(openSessions.getByRole('button', { name: 'Forget' })).toHaveCount(0);
  await expect(savedSessions.getByRole('listitem')).toHaveCount(1);
  await expect(savedSessions.getByRole('button', { name: 'Copy', exact: true })).toHaveCount(0);
  await expect(savedSessions.getByRole('button', { name: 'Open' })).toHaveCount(1);
  await expect(savedSessions.getByRole('button', { name: 'Forget' })).toHaveCount(1);

  await openSessions.getByRole('button', { name: 'Close' }).click();
  await expect.poll(() => closed).toBe(true);
  await expect(page.getByRole('heading', { name: 'Open sessions' })).toHaveCount(0);
  await expect(savedSessions.getByRole('listitem')).toHaveCount(2);

  await savedSessions
    .getByRole('listitem')
    .filter({ hasText: '/projects/running' })
    .getByRole('button', { name: 'Open' })
    .click();
  await expect.poll(() => reopened).toBe(true);
  await expect(page.getByRole('button', { name: 'Chat', pressed: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sessions' }).click();
  await expect(openSessions.getByText('/projects/running')).toBeVisible();
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
  await expect(page.getByLabel('Model')).toHaveCount(0);
  await page.getByRole('button', { name: 'New session' }).click();
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
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );

  await page.goto('/');

  await openChat(page);
  await expect(page.getByRole('heading', { name: 'Codex needs your decision' })).toBeVisible();
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
  await page.getByRole('button', { name: 'New session' }).click();

  await expect(page.getByRole('button', { name: 'New session' })).toBeEnabled();
  await expect(repository).toHaveAttribute('aria-selected', 'true');
  const intermediate = page.getByRole('treeitem', { name: /^group/ });
  await intermediate.click();
  await expect(intermediate).toHaveAttribute('aria-selected', 'true');
  await expect(repository).toHaveAttribute('aria-selected', 'false');
  await page.getByRole('button', { name: 'New session' }).click();

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
      body: JSON.stringify({ items: [], currentSequence: 0 }),
    }),
  );

  await page.goto('/');

  await openChat(page);
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
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
  await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('shows Git state and confirms a safe upstream push', async ({ page }) => {
  const session = {
    id: 'session-1',
    state: 'ready',
    workspaceId: 'workspace-1',
    profile: 'work',
    activeTurnId: null,
  };
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
  let pushed = false;
  let checkedOut = 'main';
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
      body: JSON.stringify({ items: [], currentSequence: 0 }),
    }),
  );
  await page.route('**/api/sessions/session-1/git', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ...summary, branch: checkedOut }),
    }),
  );
  await page.route('**/api/sessions/session-1/git/checkout', async (route) => {
    checkedOut = (route.request().postDataJSON() as { branch: string }).branch;
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/sessions/session-1/git/push', async (route) => {
    pushed = true;
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Git' }).click();

  await expect(page.getByLabel('Branch')).toHaveValue('main');
  await expect(page.getByText('Upstream: origin/main')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Push' })).toBeEnabled();
  await page.getByRole('button', { name: 'Push' }).click();
  await expect(page.getByText('Push HEAD to origin/main?')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm push' }).click();
  await expect.poll(() => pushed).toBe(true);
  await page.getByLabel('Branch').selectOption('topic');
  await expect.poll(() => checkedOut).toBe('topic');
  await expect(page.getByLabel('Branch')).toHaveValue('topic');
});

test('clones a repository from the Git tab into the selected workspace', async ({ page }) => {
  let cloneRequest: { workspaceId: string; address: string } | null = null;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree([workspaceNode('workspace-2', 'archive')]),
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [],
      }),
    }),
  );
  await page.route('**/api/git/clone', async (route) => {
    cloneRequest = route.request().postDataJSON() as { workspaceId: string; address: string };
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Git' }).click();
  await page.getByLabel('Destination workspace').selectOption('workspace-2');
  await page.getByLabel('Git address').fill('https://example.test/cloned-repo.git');
  await page.getByRole('button', { name: 'Clone' }).click();

  await expect
    .poll(() => cloneRequest)
    .toEqual({
      workspaceId: 'workspace-2',
      address: 'https://example.test/cloned-repo.git',
    });
  await expect(page.getByRole('status').filter({ hasText: 'selected workspace' })).toBeVisible();
});

test('preserves the Sessions highlight and folding after a bootstrap refresh', async ({ page }) => {
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
  await page.getByLabel('Destination workspace').selectOption(intermediateId);
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
            text: 'No changes are needed.\n\nInstallation | What it receives\n|---|---|\n| `npx skills add` | Only `my-skill/` |',
          },
          { id: 'command-1', kind: 'command', command: 'git status', status: 'completed' },
        ],
      }),
    }),
  );

  await page.goto('/');

  await openChat(page);
  await expect(page.getByText('Check the branch')).toBeVisible();
  await expect(page.getByText('answer')).toBeVisible();
  await expect(page.getByText('No changes are needed.')).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Installation' })).toBeVisible();
  await expect(page.getByText('npx skills add')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Interrupt' })).toBeVisible();
  const commentary = page.locator('.answer-turn');
  await expect(commentary.getByText('I am inspecting the branch.')).toBeHidden();
  await commentary.getByText('commentary').click();
  await expect(commentary.getByText('I am inspecting the branch.')).toBeVisible();
  await expect(commentary.getByText('The branch is clean.')).toBeVisible();
  await expect(page.getByText('Command · completed')).toBeVisible();
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
  const session = {
    id: 'session-1',
    state: 'ready',
    workspaceId: 'workspace-1',
    profile: 'work',
    activeTurnId: null,
  };
  let completeRefresh: (() => void) | undefined;
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
      body: JSON.stringify({ items: [], currentSequence: 0 }),
    }),
  );
  await page.route('**/api/sessions/session-1/git', (route) =>
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
  await page.route('**/api/sessions/session-1/git/pull', async (route) => {
    await new Promise<void>((resolve) => {
      completeRefresh = resolve;
    });
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Git' }).click();
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
      body: JSON.stringify({ items: [], currentSequence: 0 }),
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
  await expect(page.getByRole('heading', { name: 'Codex needs your decision' })).toBeVisible();
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
      body: JSON.stringify({ items: [], currentSequence: 0 }),
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
  await page.getByRole('button', { name: 'Safe' }).click();
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
      body: JSON.stringify({ items: [], currentSequence: 0 }),
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
  await expect(page.getByText('commentary', { exact: true })).toBeVisible();
  await expect(page.getByText('Working on it.\nStill working.')).toBeHidden();
  await expect(page.locator('ol[aria-label="Chat messages"] li')).toHaveCSS(
    'white-space',
    'pre-wrap',
  );
});

test('projects a live activity update from the relay socket', async ({ page }) => {
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
      body: JSON.stringify({ items: [], currentSequence: 0 }),
    }),
  );
  await page.routeWebSocket('ws://127.0.0.1:4173/api/sessions/session-1/events?after=0', (socket) =>
    socket.send(
      JSON.stringify({
        type: 'relay.event',
        event: {
          sequence: 1,
          type: 'activity.updated',
          payload: { id: 'item-1', label: 'Command · completed', detail: 'git status' },
        },
      }),
    ),
  );

  await page.goto('/');
  await openChat(page);
  await expect(page.getByText('Command · completed')).toBeVisible();
  await page.getByText('Command · completed').click();
  await expect(page.getByText('git status')).toBeVisible();
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
        currentSequence: 8,
        items: reads === 1 ? [] : [{ id: 'agent-1', kind: 'agent', text: 'Recovered history' }],
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
        currentSequence: reads === 1 ? 0 : 3,
        items:
          reads === 1 ? [] : [{ id: 'agent-1', kind: 'agent', text: 'Recovered missing event' }],
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
      body: JSON.stringify({ items: [], currentSequence: 0 }),
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
  await expect(page.getByText('commentary', { exact: true })).toBeVisible();
  await expect(page.getByText('before drop after replay')).toBeHidden();
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
        currentSequence: reads === 1 ? 0 : 4,
        items:
          reads === 1 ? [] : [{ id: 'restored', kind: 'agent', text: 'Restored after restart' }],
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
  await expect(page.getByText('commentary', { exact: true })).toBeVisible();
  await expect(page.getByText('live again')).toBeHidden();
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
      body: JSON.stringify({ items: [], currentSequence: 0 }),
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

test('shows Gestalt branding and changes appearance from configuration', async ({ page }) => {
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: [], profiles: [], sessions: [] }),
    }),
  );

  await page.goto('/');
  await expect(page).toHaveTitle('Gestalt Mobile');
  await expect(page.getByRole('link', { name: 'Gestalt Mobile' })).toBeVisible();

  await page.getByRole('button', { name: 'Open configuration' }).click();
  await expect(page.locator('.configuration-brand')).toBeVisible();
  await page.getByLabel('Appearance').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
