/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Page } from '@playwright/test';
import type { SupervisedPlan } from '../../src/client/features/plans/contracts.js';
import { THEME_STORAGE_KEY } from '../../src/client/features/theme/theme-registry.js';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture, deferred } from './chat-relay-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';
import { expectNoHorizontalOverflow } from './theme-evidence.js';

function plan(title: string): SupervisedPlan {
  return {
    title,
    subtitle: 'Detailed implementation plan',
    steps: [
      {
        id: 'delivery',
        title: 'Deliver the desktop workspace',
        level: 1,
        state: 'WIP',
        priority: 'A',
        reviewStatus: 'UNREVIEWED',
        description: {
          effort: 'Medium',
          goal: 'Keep session context beside the conversation.',
          notes: 'A long background explanation. '.repeat(30),
        },
        children: [
          {
            id: 'layout',
            title: 'Build the three-column layout',
            level: 2,
            state: 'WIP',
            priority: 'A',
            description: {
              why: 'Avoid switching tabs.',
              change: 'Reuse the session and plan views.',
              tests: 'Verify narrow and wide screens.',
              doneWhen: 'Every column remains readable.',
            },
            children: [],
          },
        ],
      },
      {
        id: 'review',
        title: 'Review the result',
        level: 1,
        state: 'TODO',
        priority: 'B',
        description: { goal: 'Verify the complete change.' },
        children: [],
      },
    ],
    totalSteps: 3,
    doneSteps: 0,
    allDone: false,
    currentStepId: 'layout',
  };
}

async function install(page: Page) {
  await mockAuthenticatedStatus(page);
  const fixture = new ChatRelayFixture(page);
  await fixture.install(
    ['alpha', 'beta'].map((id) => ({
      id,
      state: 'ready',
      threadId: id,
      workspaceId: id,
      workspacePath: `/workspace/${id}`,
      profile: 'default',
      model: 'gpt-6.1-sol',
      activeTurnId: null,
      pendingInteractions: [],
    })),
  );
  for (const id of ['alpha', 'beta'])
    fixture.snapshot(
      id,
      chatSnapshot({
        items: [{ id: `${id}-message`, kind: 'user', text: `${id} conversation`, turnId: id }],
      }),
    );
  await page.route('**/api/sessions/*/activity/refresh', (route) => route.fulfill({ json: {} }));
  const plans = new Map<string, SupervisedPlan | null>([
    ['alpha', plan('Alpha plan')],
    ['beta', plan('Beta plan')],
  ]);
  await page.route('**/api/sessions/*', (route) => {
    const id = route.request().url().split('/').at(-1);
    return route.fulfill({ json: fixture.sessions.find((session) => session.id === id) });
  });
  await page.route('**/api/sessions/*/plan', (route) => {
    const id = route.request().url().split('/').at(-2)!;
    const value = plans.get(id);
    return value ? route.fulfill({ json: value }) : route.fulfill({ status: 204 });
  });
  await page.route('**/api/skill-profiles', (route) => route.fulfill({ json: { profiles: [] } }));
  await page.route('**/api/codex/allowance', (route) =>
    route.fulfill({
      json: {
        weeklyRemainingPercent: 63,
        weeklyResetsAt: Date.now() / 1000 + 86400,
        resetsAvailable: 2,
      },
    }),
  );
  return { fixture, plans };
}

test('a delayed reconnect roster preserves the loaded plan, accepted updates and detach without moving selection or scroll', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture, plans } = await install(page);
  fixture.snapshot(
    'alpha',
    chatSnapshot({
      items: Array.from({ length: 40 }, (_, index) => ({
        id: `alpha-history-${index}`,
        kind: 'user' as const,
        text: `Alpha history ${index}. ${'Conversation detail. '.repeat(20)}`,
        turnId: 'alpha',
      })),
    }),
  );
  const gates = [deferred<Array<Record<string, unknown>>>()];
  let listGate = gates[0]!;
  const settled: Promise<void>[] = [];
  let listRequests = 0;
  await page.route('**/api/sessions', async (route) => {
    const gate = listGate;
    const done = deferred<void>();
    settled.push(done.promise);
    listRequests++;
    try {
      await route.fulfill({ json: await gate.promise });
    } finally {
      done.resolve();
    }
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    const left = page.getByRole('complementary', { name: 'Chat sessions and usage' });
    const right = page.getByRole('complementary', { name: 'Chat plan summary' });
    const alpha = left.locator('[data-session-id="alpha"]');
    const beta = left.locator('[data-session-id="beta"]');
    await expect(right.getByRole('heading', { name: 'Alpha plan', exact: true })).toBeVisible();
    await expect(
      alpha.getByRole('progressbar', { name: 'Plan progress for Alpha plan', exact: true }),
    ).toBeVisible();
    await expect(alpha.locator('.agents summary')).toBeVisible();
    await expect.poll(() => listRequests).toBeGreaterThan(0);
    // The initial plan is already published while every reconnect list remains held.
    listGate.resolve(
      fixture.sessions.map((row) => ({
        ...row,
        workspacePath: `${row.workspacePath}/after-initial-list`,
      })),
    );
    await expect(alpha).toContainText('/workspace/alpha/after-initial-list');
    await expect(
      alpha.getByRole('progressbar', { name: 'Plan progress for Alpha plan', exact: true }),
    ).toBeVisible();
    await expect(alpha.locator('.agents summary')).toBeVisible();
    await expect(right.getByRole('heading', { name: 'Alpha plan', exact: true })).toBeVisible();

    await page.evaluate(() => window.scrollTo(0, 350));
    const before = await page.evaluate(() => window.scrollY);
    const updated = { ...plan('Alpha plan updated'), currentStepId: 'review', doneSteps: 2 };
    plans.set('alpha', updated);
    fixture.event('alpha', 1, 'plan.updated', { plan: updated, reason: null });
    await expect(right.getByRole('heading', { name: updated.title, exact: true })).toBeVisible();
    await expect(
      alpha.getByRole('progressbar', { name: `Plan progress for ${updated.title}`, exact: true }),
    ).toHaveAttribute('value', '2');
    await expect(right.locator('details[data-step-id="review"]')).toHaveJSProperty('open', true);
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThanOrEqual(2);

    // Detach is newer than a held roster carrying an obsolete embedded plan and
    // attached metadata. Neither that list nor a later session switch may revive it.
    plans.set('alpha', null);
    fixture.event('alpha', 2, 'plan.closed', {});
    await expect(right).toContainText('No retained plan for this session.');
    await expect(alpha.locator('.agents')).toHaveCount(0);
    const requestedBeforeDetach = listRequests;
    listGate = deferred<Array<Record<string, unknown>>>();
    gates.push(listGate);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => listRequests).toBeGreaterThan(requestedBeforeDetach);
    listGate.resolve(
      fixture.sessions.map((row) => ({
        ...row,
        workspacePath: `${row.workspacePath}/after-detach-list`,
        ...(row.id === 'alpha'
          ? {
              plan: plan('Obsolete Alpha plan'),
              lastOrgPlan: { filename: 'obsolete.org', title: 'Obsolete Alpha', attached: true },
            }
          : {}),
      })),
    );
    await expect(alpha).toContainText('/workspace/alpha/after-detach-list');
    await expect(alpha.locator('.session-plan-progress')).toHaveCount(0);
    await expect(alpha.locator('.agents')).toHaveCount(0);
    await expect(alpha).not.toContainText('Org plan attached');
    await beta.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(right.getByRole('heading', { name: 'Beta plan', exact: true })).toBeVisible();
    await expect(
      beta.getByRole('progressbar', { name: 'Plan progress for Beta plan', exact: true }),
    ).toBeVisible();
    await expect(beta.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(alpha.locator('.session-plan-progress')).toHaveCount(0);
    await expect(right).not.toContainText('Obsolete Alpha');
    await expectNoHorizontalOverflow(page);
  } finally {
    gates.forEach((gate) => gate.resolve(fixture.sessions));
    await Promise.allSettled(settled);
  }
});

test('a slow skills catalog cannot hide open sessions or overwrite a newly created session', async ({
  page,
}) => {
  const { fixture } = await install(page);
  const profiles = deferred<void>();
  let profilesRequested = false;
  await page.route('**/api/skill-profiles', async (route) => {
    profilesRequested = true;
    await profiles.promise;
    await route.fulfill({ json: { profiles: [] } });
  });
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      json: {
        workspaces: [
          {
            id: 'root',
            name: 'workspace',
            relativePath: '.',
            isGitRepository: false,
            children: [],
          },
        ],
        profiles: [],
        sessions: fixture.sessions,
      },
    }),
  );
  const created = {
    ...fixture.sessions[0],
    id: 'created',
    threadId: 'created',
    workspacePath: '/workspace/created',
  };
  fixture.snapshot('created', chatSnapshot());
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() === 'POST') {
      fixture.sessions.push(created);
      return route.fulfill({ status: 201, json: created });
    }
    return route.fulfill({ json: fixture.sessions });
  });
  try {
    await page.goto('/');
    await expect.poll(() => profilesRequested).toBe(true);
    await expect(page.getByRole('list', { name: 'Open sessions' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Create session', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
    profiles.resolve();
    await page.getByRole('button', { name: 'Sessions', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Open sessions' })).toContainText(
      '/workspace/created',
    );
    await expect(page.locator('.current-session')).toContainText('/workspace/created');
  } finally {
    profiles.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('a delayed bootstrap cannot replace a refreshed roster or the selected chat', async ({
  page,
}) => {
  const { fixture } = await install(page);
  const bootstrap = deferred<void>();
  const originalSessions = fixture.sessions.slice();
  let bootstrapRequested = false;
  await page.route('**/api/bootstrap', async (route) => {
    bootstrapRequested = true;
    await bootstrap.promise;
    await route.fulfill({ json: { workspaces: [], profiles: [], sessions: originalSessions } });
  });
  fixture.sessions.push({
    ...fixture.sessions[0],
    id: 'external',
    workspacePath: '/workspace/external',
  });
  try {
    await page.goto('/');
    await expect.poll(() => bootstrapRequested).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const roster = page.getByRole('list', { name: 'Open sessions' });
    await expect(roster).toContainText('/workspace/external');
    await roster
      .locator('.managed-session')
      .filter({ hasText: '/workspace/beta' })
      .getByRole('button', { name: 'Open', exact: true })
      .click();
    await expect(page.getByText('beta conversation', { exact: true })).toBeVisible();
    const initialized = page.waitForResponse('**/api/sessions/recent-threads');
    bootstrap.resolve();
    await initialized;
    await expect(page.getByText('beta conversation', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sessions', exact: true }).click();
    await expect(roster).toContainText('/workspace/external');
    await expect(page.locator('.current-session')).toContainText('/workspace/beta');
  } finally {
    bootstrap.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('a failed refresh cannot discard a successful bootstrap roster', async ({ page }) => {
  await install(page);
  const bootstrap = deferred<void>();
  let bootstrapRequested = false;
  await page.route('**/api/bootstrap', async (route) => {
    bootstrapRequested = true;
    await bootstrap.promise;
    await route.fallback();
  });
  await page.route('**/api/sessions', (route) => route.fulfill({ status: 503, json: {} }));
  try {
    await page.goto('/');
    await expect.poll(() => bootstrapRequested).toBe(true);
    const failedRefresh = page.waitForResponse('**/api/sessions');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect((await failedRefresh).status()).toBe(503);
    const initialized = page.waitForResponse('**/api/sessions/recent-threads');
    bootstrap.resolve();
    await initialized;
    await expect(page.getByRole('list', { name: 'Open sessions' })).toContainText(
      '/workspace/beta',
    );
    await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeEnabled();
  } finally {
    bootstrap.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

for (const width of [390, 1440]) {
  test(`Sessions keeps open sessions visible after returning from Chat at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await install(page);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    const roster = page.getByRole('list', { name: 'Open sessions' });
    await expect(roster).toBeVisible();
    await expect(roster.locator('li.managed-session')).toHaveCount(2);
    for (const id of ['beta', 'alpha', 'beta']) {
      await roster
        .locator('.managed-session')
        .filter({ hasText: `/workspace/${id}` })
        .getByRole('button', { name: 'Open', exact: true })
        .click();
      await expect(page.getByText(`${id} conversation`, { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Sessions', exact: true }).click();
      await expect(roster).toBeVisible();
      await expect(roster.locator('li.managed-session')).toHaveCount(2);
    }
    expect(errors).toEqual([]);
  });
}

for (const { width, scale, theme } of [
  { width: 390, scale: 1, theme: 'minimal-light' },
  { width: 1024, scale: 1, theme: 'minimal-light' },
  { width: 1279, scale: 1, theme: 'minimal-light' },
  { width: 1366, scale: 1, theme: 'minimal-light' },
  { width: 1440, scale: 1, theme: 'minimal-light' },
  { width: 1920, scale: 1, theme: 'minimal-dark' },
  { width: 1440, scale: 2, theme: 'minimal-dark' },
  { width: 2880, scale: 2, theme: 'minimal-light' },
]) {
  test(`Chat adapts to ${width}px at ${scale}x text in ${theme}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(({ key, theme }) => localStorage.setItem(key, theme), {
      key: THEME_STORAGE_KEY,
      theme,
    });
    await install(page);
    await page.goto('/');
    await page.evaluate(
      (scale) => (document.documentElement.style.fontSize = `${scale * 100}%`),
      scale,
    );
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(page.getByText('alpha conversation', { exact: true })).toBeVisible();
    const left = page.getByRole('complementary', { name: 'Chat sessions and usage' });
    const right = page.getByRole('complementary', { name: 'Chat plan summary' });
    if (width >= 1408 * scale) {
      await expect(left).toBeVisible();
      await expect(right.getByRole('heading', { name: 'Alpha plan' })).toBeVisible();
      await expect(left.getByRole('region', { name: 'Codex allowance' })).toContainText('63% left');
      await expect(left.getByRole('list', { name: 'Open sessions' })).toContainText(
        '/workspace/beta',
      );
      await expect(page.getByRole('heading', { name: 'New session', exact: true })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Recent sessions', exact: true })).toHaveCount(
        0,
      );
      await expect(right.getByRole('progressbar', { name: 'Plan progress' })).toBeVisible();
      await expect(right).toContainText('Review the result');
      await expect(right).toContainText('Effort:');
      await expect(right).not.toContainText('A long background explanation. '.repeat(30));
      const [l, c, r] = await Promise.all([
        left.boundingBox(),
        page.locator('.chat-view').boundingBox(),
        right.boundingBox(),
      ]);
      expect(l!.x + l!.width).toBeLessThan(c!.x);
      expect(c!.x + c!.width).toBeLessThan(r!.x);
      expect(c!.width).toBeGreaterThanOrEqual(500 * scale);
      const agents = left.locator('.agents').first();
      await agents.locator('summary').click();
      await expect(agents.locator('ul')).toBeVisible();
      await expect(async () => {
        const popup = (await agents.locator('ul').boundingBox())!;
        const sidebar = (await left.boundingBox())!;
        expect(popup.x).toBeGreaterThanOrEqual(sidebar.x);
        expect(popup.x + popup.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
        expect(popup.y).toBeGreaterThanOrEqual(sidebar.y);
        expect(popup.y + popup.height).toBeLessThanOrEqual(sidebar.y + sidebar.height);
      }).toPass();
      await agents.locator('summary').click();
    } else {
      await expect(left).toHaveCount(0);
      await expect(right).toHaveCount(0);
    }
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath('chat-layout.png') });
  });
}

test('sidebar selection follows the current session and live plan without scrolling the chat', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fixture } = await install(page);
  fixture.snapshot(
    'beta',
    chatSnapshot({
      items: Array.from({ length: 40 }, (_, index) => ({
        id: `message-${index}`,
        kind: 'user' as const,
        text: `Beta history ${index}. ${'Conversation detail. '.repeat(20)}`,
        turnId: 'beta',
      })),
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const left = page.getByRole('complementary', { name: 'Chat sessions and usage' });
  const right = page.getByRole('complementary', { name: 'Chat plan summary' });
  await expect(right.getByRole('heading', { name: 'Alpha plan' })).toBeVisible();
  await left
    .locator('.managed-session')
    .filter({ hasText: '/workspace/beta' })
    .getByRole('button', { name: 'Open', exact: true })
    .click();
  await expect(right.getByRole('heading', { name: 'Beta plan' })).toBeVisible();
  await expect(right).not.toContainText('Alpha plan');
  await expect(left.locator('[aria-current="page"]')).toHaveCount(1);
  await page.evaluate(() => window.scrollTo(0, 350));
  const before = await page.evaluate(() => window.scrollY);
  const next = { ...plan('Beta plan updated'), currentStepId: 'review', doneSteps: 2 };
  fixture.event('beta', 1, 'plan.updated', { plan: next, reason: null });
  await expect(right.getByRole('heading', { name: 'Beta plan updated' })).toBeVisible();
  await expect(right.getByRole('progressbar', { name: 'Plan progress' })).toHaveAttribute(
    'value',
    '2',
  );
  await expect(right.locator('details[data-step-id="review"]')).toHaveJSProperty('open', true);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThanOrEqual(2);
});

test('sidebars resize live, show the selected session empty plan, and open the full Plan tab', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { plans } = await install(page);
  plans.set('beta', null);
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const right = page.getByRole('complementary', { name: 'Chat plan summary' });
  await expect(right).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(right).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(right).toBeVisible();
  await right.getByRole('button', { name: 'Full plan' }).click();
  await expect(page.getByRole('button', { name: 'Plan', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(right).toHaveCount(0);
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await right.getByRole('button', { name: 'Full plan' }).click();
  await expect(page.getByRole('heading', { name: 'Alpha plan', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close plan and return to list' }).click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await right.getByRole('button', { name: 'Full plan' }).click();
  await expect(page.getByRole('heading', { name: 'Alpha plan', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Chat sessions and usage' })
    .locator('.managed-session')
    .filter({ hasText: '/workspace/beta' })
    .getByRole('button', { name: 'Open', exact: true })
    .click();
  await expect(right).toContainText('No retained plan for this session.');
  await expect(right).not.toContainText('Alpha plan');
});
