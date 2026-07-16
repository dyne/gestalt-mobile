import { expect, test } from '@playwright/test';

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
        workspaces: [{ id: 'workspace-1', name: 'project' }],
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [],
      }),
    }),
  );
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({
        workspaceId: 'workspace-1',
        profile: 'work',
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

  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible();
  await expect(page.getByText('Connected Codex session: codex-thread-1')).toBeVisible();
  await page.getByRole('textbox', { name: 'Message' }).fill('Inspect this workspace');
  await page.getByRole('textbox', { name: 'Message' }).press('Enter');
  await expect(page.getByText('Inspect this workspace')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Interrupt' })).toBeVisible();
});

test('labels relay threads as sessions and shows recent sessions from Codex', async ({ page }) => {
  await page.addInitScript(() => {
    Date.now = () => Date.UTC(2026, 6, 15, 12, 0, 0);
  });
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: [{ id: 'workspace-1', name: 'project' }],
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [
          {
            id: 'relay-session-1',
            state: 'ready',
            threadId: 'relay-thread-id',
            workspaceId: 'workspace-1',
            workspacePath: '/projects/relay',
            profile: 'work',
            updatedAt: '2026-07-15T10:00:00.000Z',
          },
        ],
      }),
    }),
  );
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 'recent-thread-id', cwd: '/projects/from-ssh', recencyAt: 1784109600 },
        { id: 'relay-thread-id', cwd: '/projects/relay', recencyAt: 1784102400 },
      ]),
    }),
  );
  await page.route('**/api/sessions/relay-session-1/history', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions' }).click();

  await expect(page.getByLabel('Saved sessions').getByText('relay-thread-id')).toBeVisible();
  await expect(page.getByLabel('Saved sessions').getByText('/projects/relay')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Last sessions' })).toBeVisible();
  await expect(page.getByLabel('Last sessions').getByText('2 hours ago')).toBeVisible();
  await expect(page.getByLabel('Last sessions').getByText('/projects/from-ssh')).toBeVisible();
  await expect(page.getByLabel('Last sessions').getByText('recent-thread-id')).toBeVisible();
  await expect(page.getByText('Thread relay-thread-id')).toHaveCount(0);
});

test('manages saved sessions with their running state, resume command, and forget action', async ({
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
  let forgotten = false;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: [{ id: 'workspace-1', name: 'project' }],
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions,
      }),
    }),
  );
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/sessions/running-session', async (route) => {
    expect(route.request().method()).toBe('DELETE');
    forgotten = true;
    await route.fulfill({ status: 204 });
  });
  await page.route('**/api/sessions', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(forgotten ? [sessions[1]] : sessions),
    }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions' }).click();

  const savedSessions = page.getByLabel('Saved sessions');
  await expect(savedSessions.getByRole('button', { name: 'Open' })).toHaveCount(2);
  await expect(savedSessions.getByText('running', { exact: true })).toHaveCount(1);
  await expect(savedSessions.getByRole('button', { name: 'Copy resume command' })).toHaveCount(2);
  await expect(savedSessions.getByRole('button', { name: 'Forget' })).toHaveCount(2);
  await expect(savedSessions.getByRole('button', { name: /Release|Restore/ })).toHaveCount(0);

  await savedSessions.getByRole('button', { name: 'Forget' }).first().click();
  await expect.poll(() => forgotten).toBe(true);
  await expect(savedSessions.getByText('running-thread')).toHaveCount(0);
});

test('starts a session with profile, sandbox, and approval settings', async ({ page }) => {
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: [{ id: 'workspace-1', name: 'project' }],
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
      profile: 'work',
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
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible();
});

test('rehydrates a durable pending interaction after a browser reload', async ({ page }) => {
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: [{ id: 'workspace-1', name: 'project' }],
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

  await expect(page.getByRole('heading', { name: 'Codex needs your decision' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
});

test('shows a start-session failure and permits a retry', async ({ page }) => {
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: [{ id: 'workspace-1', name: 'project' }],
        profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
        sessions: [],
      }),
    }),
  );
  await page.route('**/api/sessions', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      body: JSON.stringify({ detail: 'Codex app-server is unavailable.' }),
    }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByRole('button', { name: 'New session' }).click();

  await expect(page.getByRole('status')).toContainText(
    'Could not start session: Codex app-server is unavailable.',
  );
  await expect(page.getByRole('button', { name: 'New session' })).toBeEnabled();
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
        workspaces: [{ id: 'workspace-1', name: 'project' }],
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

  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
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
        workspaces: [{ id: 'workspace-1', name: 'project' }],
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
    upstream: 'origin/main',
    ahead: 2,
    behind: 0,
    dirty: { staged: 1, unstaged: 0, untracked: 0 },
    commits: [],
    fetchedAt: '2026-07-14T10:00:00.000Z',
  };
  let pushed = false;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: [{ id: 'workspace-1', name: 'project' }],
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
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(summary) }),
  );
  await page.route('**/api/sessions/session-1/git/push', async (route) => {
    pushed = true;
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Git' }).click();
  await page.getByRole('button', { name: 'Load status' }).click();

  await expect(page.getByText('Branch: main · upstream: origin/main')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Push' })).toBeEnabled();
  await page.getByRole('button', { name: 'Push' }).click();
  await expect(page.getByText('Push HEAD to origin/main?')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm push' }).click();
  await expect.poll(() => pushed).toBe(true);
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
        workspaces: [{ id: 'workspace-1', name: 'project' }],
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
        workspaces: [{ id: 'workspace-1', name: 'project' }],
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

  await expect(page.getByText('Initial message')).toBeVisible();
  await expect(page.getByText('Message from terminal')).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText('Terminal answer')).toBeVisible();
});

test('shows Git fetch progress and disables push without an upstream', async ({ page }) => {
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
        workspaces: [{ id: 'workspace-1', name: 'project' }],
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
        upstream: null,
        ahead: 1,
        behind: 0,
        dirty: { staged: 0, unstaged: 0, untracked: 0 },
        commits: [],
        fetchedAt: null,
      }),
    }),
  );
  await page.route('**/api/sessions/session-1/git/refresh', async (route) => {
    await new Promise<void>((resolve) => {
      completeRefresh = resolve;
    });
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Git' }).click();
  await page.getByRole('button', { name: 'Load status' }).click();
  await expect(page.getByRole('button', { name: 'Push' })).toBeDisabled();
  await page.getByRole('button', { name: 'Fetch' }).click();
  await expect(page.getByRole('button', { name: 'Fetching…' })).toBeDisabled();
  completeRefresh?.();
  await expect(page.getByRole('button', { name: 'Fetch' })).toBeEnabled();
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
        workspaces: [{ id: 'workspace-1', name: 'project' }],
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
    /ws:\/\/127\.0\.0\.1:5173\/api\/sessions\/session-1\/events\?after=\d+/,
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
        workspaces: [{ id: 'workspace-1', name: 'project' }],
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
    /ws:\/\/127\.0\.0\.1:5173\/api\/sessions\/session-1\/events\?after=\d+/,
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
        workspaces: [{ id: 'workspace-1', name: 'project' }],
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
    'ws://127.0.0.1:5173/api/sessions/session-1/events?after=0',
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
        workspaces: [{ id: 'workspace-1', name: 'project' }],
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
  await page.routeWebSocket('ws://127.0.0.1:5173/api/sessions/session-1/events?after=0', (socket) =>
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
        workspaces: [{ id: 'workspace-1', name: 'project' }],
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
    /ws:\/\/127\.0\.0\.1:5173\/api\/sessions\/session-1\/events\?after=\d+/,
    (socket) => {
      socket.send(JSON.stringify({ type: 'relay.resyncRequired', currentSequence: 8 }));
    },
  );

  await page.goto('/');
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
        workspaces: [{ id: 'workspace-1', name: 'project' }],
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
    'ws://127.0.0.1:5173/api/sessions/session-1/events?after=0',
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
        workspaces: [{ id: 'workspace-1', name: 'project' }],
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
    /ws:\/\/127\.0\.0\.1:5173\/api\/sessions\/session-1\/events\?after=\d+/,
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
        workspaces: [{ id: 'workspace-1', name: 'project' }],
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
    /ws:\/\/127\.0\.0\.1:5173\/api\/sessions\/session-1\/events\?after=\d+/,
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

  await expect(page.getByText('Restored after restart')).toBeVisible();
  await expect(page.getByText('commentary', { exact: true })).toBeVisible();
  await expect(page.getByText('live again')).toBeHidden();
  await expect.poll(() => connections).toBe(2);
  await expect(page.getByRole('status')).toHaveText('Ready for your next instruction.');
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
        workspaces: [{ id: 'workspace-1', name: 'project' }],
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
    'ws://127.0.0.1:5173/api/sessions/session-1/events?after=0',
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

  await expect(page.getByRole('button', { name: 'Interrupt' })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Message' }).fill('Continue after recovery');
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
  const chat = page.getByRole('button', { name: 'Chat', pressed: true });
  await chat.press('ArrowRight');
  await expect(page.getByRole('heading', { name: 'Git' })).toBeVisible();
  const git = page.getByRole('button', { name: 'Git', pressed: true });
  await expect(git).toBeFocused();
  await git.press('ArrowLeft');
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Chat', pressed: true })).toBeFocused();
});
