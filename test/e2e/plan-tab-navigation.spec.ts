/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

const session = (id: string, workspacePath: string) => ({
  id,
  state: 'ready',
  threadId: `${id}-thread`,
  workspaceId: 'workspace-1',
  workspacePath,
  profile: 'default',
  activeTurnId: null,
});

const completedPlan = {
  title: 'Responsive plan',
  subtitle: 'A retained plan for mobile navigation',
  steps: [
    {
      id: 'finish',
      title: 'Finish navigation',
      level: 1,
      state: 'DONE',
      priority: 'A',
      reviewStatus: 'UNREVIEWED',
      description: { goal: 'Keep every input path consistent.' },
      measurement: { weeklyRemainingCurrent: 63 },
      children: [],
    },
  ],
  totalSteps: 1,
  doneSteps: 1,
  allDone: true,
  currentStepId: 'finish',
};

const activePlan = {
  ...completedPlan,
  allDone: false,
  doneSteps: 0,
};

async function routeSessionHistory(page: Page, id: string): Promise<void> {
  await page.route(`**/api/sessions/${id}/history`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(chatSnapshot()),
    }),
  );
}

test('keeps the completed Plan tab reachable and overflow-free at 320px with 200% root font', async ({
  page,
}) => {
  const selected = session('session-1', '/projects/one');
  let closed = false;
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: [], profiles: [], sessions: [selected] }),
    }),
  );
  await routeSessionHistory(page, selected.id);
  await page.route(`**/api/sessions/${selected.id}/plan`, (route) => {
    if (route.request().method() === 'DELETE') {
      closed = true;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(completedPlan) });
  });
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.routeWebSocket(
    /ws:\/\/127\.0\.0\.1:4173\/api\/sessions\/session-1\/events\?after=\d+/,
    () => {},
  );

  await mockAuthenticatedStatus(page);
  await page.goto('/');
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });

  const navigation = page.getByLabel('Primary');
  const weeklyQuota = page.getByLabel('Weekly quota remaining');
  await expect(weeklyQuota).toHaveText('63% left');
  await expect(weeklyQuota.locator('+ .menu-trigger')).toHaveCount(1);
  await expect(navigation.getByRole('button')).toHaveText(['Sessions', 'Git', 'Chat', 'Plan']);
  const horizontalLayout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll<HTMLElement>('*')]
      .filter(
        (element) =>
          element.getBoundingClientRect().right > window.innerWidth + 1 ||
          element.getBoundingClientRect().left < -1,
      )
      .map((element) => ({
        name: element.tagName,
        className: element.className,
        left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      })),
  }));
  expect(horizontalLayout.overflow).toEqual([]);
  expect(horizontalLayout.scrollWidth).toBeLessThanOrEqual(horizontalLayout.clientWidth);

  const chat = navigation.getByRole('button', { name: 'Chat' });
  const plan = navigation.getByRole('button', { name: 'Plan' });
  for (const tab of ['Sessions', 'Git', 'Chat', 'Plan']) {
    await navigation.getByRole('button', { name: tab }).click();
    await expect(weeklyQuota).toHaveText('63% left');
  }
  await chat.click();
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Keep this chat draft');

  await chat.focus();
  await chat.press('Tab');
  await expect(plan).toBeFocused();
  await plan.press('Enter');
  await expect(plan).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Responsive plan' })).toBeVisible();

  await chat.click();
  await chat.focus();
  await chat.press(' ');
  await expect(chat).toHaveAttribute('aria-pressed', 'true');
  await expect(prompt).toHaveValue('Keep this chat draft');

  await chat.press('ArrowRight');
  await expect(plan).toBeFocused();
  await expect(plan).toHaveAttribute('aria-pressed', 'true');
  await plan.press('ArrowRight');
  await expect(navigation.getByRole('button', { name: 'Sessions' })).toBeFocused();

  await chat.click();
  const main = page.locator('main');
  await main.dispatchEvent('pointerdown', {
    pointerType: 'touch',
    pointerId: 4,
    clientX: 240,
    clientY: 240,
  });
  await main.dispatchEvent('pointerup', {
    pointerType: 'touch',
    pointerId: 4,
    clientX: 100,
    clientY: 242,
  });
  await expect(plan).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Close plan and return to list' }).click();
  await expect.poll(() => closed).toBe(false);
  await expect(page.getByRole('heading', { name: 'Plans' })).toBeVisible();
  await expect(plan).toHaveAttribute('aria-pressed', 'true');
});

test('updates Plan from live events without selecting it, then isolates a session without a plan', async ({
  page,
}) => {
  const first = session('session-1', '/projects/one');
  const second = session('session-2', '/projects/two');
  let emitPlanEvent: ((event: object) => void) | undefined;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: [], profiles: [], sessions: [first, second] }),
    }),
  );
  await Promise.all([routeSessionHistory(page, first.id), routeSessionHistory(page, second.id)]);
  await page.route('**/api/sessions/session-1/plan', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/sessions/session-2/plan', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.routeWebSocket(
    /ws:\/\/127\.0\.0\.1:4173\/api\/sessions\/session-1\/events\?after=\d+/,
    (socket) => {
      emitPlanEvent = (event) => socket.send(JSON.stringify({ type: 'relay.event', event }));
    },
  );
  await page.routeWebSocket(
    /ws:\/\/127\.0\.0\.1:4173\/api\/sessions\/session-2\/events\?after=\d+/,
    () => {},
  );

  await mockAuthenticatedStatus(page);
  await page.goto('/');
  const navigation = page.getByLabel('Primary');
  const chat = navigation.getByRole('button', { name: 'Chat' });
  await expect(navigation.getByRole('button')).toHaveText(['Sessions', 'Git', 'Chat', 'Plan']);
  await expect.poll(() => typeof emitPlanEvent).toBe('function');
  await chat.click();
  await expect(chat).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
  emitPlanEvent!({
    sequence: 1,
    type: 'plan.updated',
    payload: { plan: activePlan, reason: 'supervision-start' },
  });

  const plan = navigation.getByRole('button', { name: 'Plan' });
  await expect(plan).toBeVisible();
  await expect(chat).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
  await chat.focus();
  await chat.press('Tab');
  await expect(plan).toBeFocused();
  await plan.press('Enter');
  await expect(plan).toHaveAttribute('aria-pressed', 'true');

  emitPlanEvent!({ sequence: 2, type: 'plan.closed', payload: {} });
  await expect(plan).toHaveCount(1);
  await expect(plan).toHaveAttribute('aria-pressed', 'true');

  await navigation.getByRole('button', { name: 'Sessions' }).click();
  await page
    .getByLabel('Open sessions')
    .getByRole('listitem')
    .filter({ hasText: '/projects/two' })
    .getByRole('button', { name: /\/projects\/two/ })
    .click();
  await expect(chat).toHaveAttribute('aria-pressed', 'true');
  await expect(navigation.getByRole('button', { name: 'Plan' })).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
});

test('keeps the selected workspace plan or catalog visible across live plan updates', async ({
  page,
}) => {
  const selected = session('session-1', '/projects/one');
  const workspacePlan = { ...activePlan, title: 'Workspace roadmap' };
  let emitPlanEvent: ((event: object) => void) | undefined;
  let releaseBootstrap = () => {};
  const bootstrapGate = new Promise<void>((resolve) => {
    releaseBootstrap = resolve;
  });
  await page.route('**/api/bootstrap', async (route) => {
    await bootstrapGate;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: [], profiles: [], sessions: [selected] }),
    });
  });
  await routeSessionHistory(page, selected.id);
  await page.route(`**/api/sessions/${selected.id}/plan`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 204 });
    const planName = (route.request().postDataJSON() as { planName: string }).planName;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        planName === 'plans/roadmap.org'
          ? workspacePlan
          : {
              kind: 'org-source',
              planName: 'notes/free-form.org',
              title: 'Free-form notes',
              source:
                '#+TITLE: Free-form notes\n#+DATE: 2026-08-22\n\n* WIP [#A] Notes\n- Goal :: Render this document clearly.',
            },
      ),
    });
  });
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/workspaces/workspace-1/plans', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          planName: 'plans/roadmap.org',
          title: workspacePlan.title,
          previewAvailable: true,
          totalSteps: workspacePlan.totalSteps,
          doneSteps: workspacePlan.doneSteps,
          allDone: workspacePlan.allDone,
        },
        {
          planName: 'notes/free-form.org',
          title: 'Free-form notes',
          previewAvailable: false,
        },
      ]),
    }),
  );
  await page.route('**/api/workspaces/workspace-1/plans/plans%2Froadmap.org', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(workspacePlan) }),
  );
  await page.route('**/api/workspaces/workspace-1/plans/notes%2Ffree-form.org', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        kind: 'org-source',
        planName: 'notes/free-form.org',
        title: 'Free-form notes',
        source: '#+TITLE: Free-form notes\n\n* Notes',
      }),
    }),
  );
  await page.routeWebSocket(
    /ws:\/\/127\.0\.0\.1:4173\/api\/sessions\/session-1\/events\?after=\d+/,
    (socket) => {
      emitPlanEvent = (event) => socket.send(JSON.stringify({ type: 'relay.event', event }));
    },
  );

  await mockAuthenticatedStatus(page);
  await page.goto('/');
  await page.getByLabel('Primary').getByRole('button', { name: 'Plan' }).click();
  await expect(page.getByText('Select a workspace to browse its local plans.')).toBeVisible();
  releaseBootstrap();
  const roadmap = page.getByRole('button', { name: /Workspace roadmap.*plans\/roadmap.org/ });
  await expect(roadmap).toBeVisible();
  await roadmap.click();
  await expect(page.getByRole('heading', { name: workspacePlan.title })).toBeVisible();
  await expect.poll(() => typeof emitPlanEvent).toBe('function');

  emitPlanEvent!({
    sequence: 1,
    type: 'plan.updated',
    payload: { plan: { ...activePlan, title: 'Live session plan' }, reason: 'update' },
  });
  await expect(page.getByRole('heading', { name: workspacePlan.title })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Live session plan' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Close plan and return to list' }).click();
  await expect(roadmap).toBeFocused();
  const notes = page.getByRole('button', {
    name: /Free-form notes.*notes\/free-form.org.*Org document/,
  });
  await notes.click();
  await expect(page.getByRole('heading', { name: 'Free-form notes' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
  await expect(page.getByText('Render this document clearly.')).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close plan and return to list' }).click();
  await expect(notes).toBeFocused();
  emitPlanEvent!({
    sequence: 2,
    type: 'plan.updated',
    payload: { plan: { ...activePlan, title: 'New live session plan' }, reason: 'update' },
  });
  await expect(page.getByRole('heading', { name: 'Plans' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'New live session plan' })).toHaveCount(0);
});
