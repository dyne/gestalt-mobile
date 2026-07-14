import { expect, test } from '@playwright/test';

test('starts a selected workspace session and opens chat', async ({ page }) => {
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
        sessions: [],
      }),
    }),
  );
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({
        workspaceId: 'workspace-1',
        profile: 'work',
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
  await page.getByRole('button', { name: 'Start session' }).click();

  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible();
  await expect(page.getByText('Connected session: session-1')).toBeVisible();
  await page.getByLabel('Message').fill('Inspect this workspace');
  await page.getByLabel('Message').press('Enter');
  await expect(page.getByRole('button', { name: 'Interrupt' })).toBeVisible();
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
        items: [
          { id: 'user-1', kind: 'user', text: 'Check the branch' },
          { id: 'agent-1', kind: 'agent', text: 'The branch is clean.' },
          { id: 'command-1', kind: 'command', command: 'git status', status: 'completed' },
        ],
      }),
    }),
  );

  await page.goto('/');

  await expect(page.getByText('user: Check the branch')).toBeVisible();
  await expect(page.getByText('assistant: The branch is clean.')).toBeVisible();
  await expect(page.getByText('Command · completed')).toBeVisible();
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
          event: { sequence: 1, type: 'agentMessageDelta', payload: { text: 'Working on it.' } },
        }),
      );
    },
  );

  await page.goto('/');
  await expect(page.getByText('assistant: Working on it.')).toBeVisible();
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
  await expect(page.getByText('assistant: Recovered history')).toBeVisible();
  await expect.poll(() => reads).toBe(2);
});
