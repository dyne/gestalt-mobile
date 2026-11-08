/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';
import { newSessionFallback } from '../../src/shared/contracts/session-defaults.js';

async function fixture(page: Page, partial = false, responseGate?: Promise<void>) {
  await mockAuthenticatedStatus(page);
  const session = {
    id: 'supervisor-created',
    state: 'ready',
    workspaceId: 'root',
    workspacePath: '/project',
    provider: 'codex',
    profile: 'default',
    model: newSessionFallback.model,
    threadId: 'thread-created',
    effectiveSkillSelection: {
      selectedProfileName: 'supervisor',
      skills: [],
      warnings: ['Optional skill is unavailable.'],
    },
  };
  const unrelated = {
    ...session,
    id: 'unrelated-saved',
    state: 'closed',
    threadId: 'unrelated-thread',
  };
  let created = false;
  let forgotten = false;
  const lifecycle: string[] = [];
  const roster = () => (created ? [unrelated, ...(forgotten ? [] : [session])] : []);
  let launches = 0;
  const forbidden: string[] = [];
  const plan = {
    title: 'Launch roadmap',
    sourcePath: '/project/.gestalt/roadmap.org',
    steps: [],
    totalSteps: 1,
    doneSteps: 0,
    allDone: false,
    currentStepId: '',
  };
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      json: {
        workspaces: [
          { id: 'root', name: 'Project', relativePath: '.', isGitRepository: true, children: [] },
        ],
        profiles: [],
        sessions: roster(),
        models: { codex: [newSessionFallback.model], kimi: [] },
      },
    }),
  );
  await page.route('**/api/skill-profiles', (route) => route.fulfill({ json: { profiles: [] } }));
  await page.route('**/api/sessions/recent-threads', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/sessions', (route) => route.fulfill({ json: roster() }));
  await page.route('**/api/sessions/supervisor-created', (route) => {
    if (route.request().method() === 'DELETE') {
      lifecycle.push('DELETE /api/sessions/supervisor-created');
      forgotten = true;
      return route.fulfill({ status: 204 });
    }
    return forgotten
      ? route.fulfill({ status: 404, json: { code: 'SESSION_NOT_FOUND' } })
      : route.fulfill({ json: session });
  });
  await page.route('**/api/sessions/supervisor-created/release', (route) => {
    expect(route.request().method()).toBe('POST');
    lifecycle.push('POST /api/sessions/supervisor-created/release');
    session.state = 'released';
    return route.fulfill({ status: 202, json: session });
  });
  await page.route('**/api/sessions/supervisor-created/history', (route) =>
    route.fulfill({
      json: chatSnapshot({
        items: partial
          ? []
          : [
              {
                id: 'bootstrap-request',
                kind: 'user',
                text: 'Supervise the exact roadmap using the Org plan workflow.',
              },
            ],
      }),
    }),
  );
  await page.route('**/api/sessions/supervisor-created/plan', (route) => {
    if (route.request().method() !== 'GET') forbidden.push('activating plan attachment');
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/sessions/supervisor-created/autopilot', (route) => {
    forbidden.push('Autopilot toggle');
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/workspaces/root/plans', (route) =>
    route.fulfill({
      json: [
        {
          planName: '.gestalt/roadmap.org',
          title: plan.title,
          previewAvailable: true,
          totalSteps: 1,
          doneSteps: 0,
          allDone: false,
        },
      ],
    }),
  );
  await page.route('**/api/workspaces/root/plans/.gestalt%2Froadmap.org', (route) =>
    route.fulfill({ json: plan }),
  );
  await page.route('**/api/plans/prepare', (route) =>
    route.fulfill({
      json: {
        kind: 'eligible',
        reference: { kind: 'workspace', workspaceId: 'root', planName: '.gestalt/roadmap.org' },
        title: plan.title,
        sourcePath: plan.sourcePath,
        revision: 'seen',
        workspace: { id: 'root', name: 'Project', path: '/project' },
        settings: {
          ...newSessionFallback,
          provider: 'codex',
          profile: 'default',
          skillProfile: 'supervisor',
        },
        skillProfiles: [{ name: 'supervisor' }],
        warnings: [],
      },
    }),
  );
  await page.route('**/api/plans/execute', async (route) => {
    launches += 1;
    created = true;
    const input = route.request().postDataJSON();
    expect(input.skillProfile).toBe('supervisor');
    if (responseGate) await responseGate;
    await route.fulfill({
      json: partial
        ? {
            kind: 'partial',
            launchId: input.launchId,
            session: { id: session.id, state: session.state },
            bootstrap: { kind: 'pending' },
            stage: 'activation',
            reason: 'Runtime startup needs recovery.',
          }
        : {
            kind: 'started',
            launchId: input.launchId,
            session: { id: session.id, state: session.state },
            bootstrap: { kind: 'accepted', requestId: 'bootstrap', turnId: 'turn' },
          },
    });
  });
  return { session, launches: () => launches, created: () => created, forbidden, lifecycle };
}
async function execute(page: Page) {
  await page.getByLabel('Primary').getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Open Launch roadmap' }).click();
  await page.getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Supervisor Skill profile' })).toHaveValue(
    'supervisor',
  );
  await page.getByRole('button', { name: 'OK', exact: true }).click();
}

for (const partial of [false, true]) {
  test(`Execute ${partial ? 'partial' : 'accepted'} receipt selects the same ordinary session and survives reload`, async ({
    page,
  }) => {
    const state = await fixture(page, partial);
    await page.goto('/');
    await execute(page);
    await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeAttached();
    await expect(
      page.getByLabel('Primary').getByRole('button', { name: 'Chat', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    if (!partial)
      await expect(
        page.getByText('Supervise the exact roadmap using the Org plan workflow.'),
      ).toBeVisible();
    else
      await expect(
        page.getByRole('alert').filter({ hasText: 'Runtime startup needs recovery.' }),
      ).toBeVisible();
    await page.reload();
    await page.getByLabel('Primary').getByRole('button', { name: 'Sessions', exact: true }).click();
    const row = page.locator(`[data-session-id="${state.session.id}"]`);
    await expect(row).toHaveCount(1);
    await expect(row.getByRole('button', { name: 'Open', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(
      row.getByText(`Model: ${newSessionFallback.model}`, { exact: true }),
    ).toBeVisible();
    await expect(row.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
    await row.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(
      page.getByLabel('Primary').getByRole('button', { name: 'Chat', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('Primary').getByRole('button', { name: 'Sessions', exact: true }).click();
    await row.getByRole('button', { name: 'Close', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Close session?' })
      .getByRole('button', { name: 'Close session', exact: true })
      .click();
    const saved = page
      .getByRole('list', { name: 'Saved sessions' })
      .locator(`[data-session-id="${state.session.id}"]`);
    await expect(saved).toBeVisible();
    await expect(saved.getByRole('button', { name: 'Open', exact: true })).toBeEnabled();
    await saved.getByRole('button', { name: 'Forget', exact: true }).click();
    await expect(page.locator(`[data-session-id="${state.session.id}"]`)).toHaveCount(0);
    expect(state.lifecycle).toEqual([
      'POST /api/sessions/supervisor-created/release',
      'DELETE /api/sessions/supervisor-created',
    ]);
    expect(state.launches()).toBe(1);
    expect(state.forbidden).toEqual([]);
  });
}

test('a launch response after leaving the viewer stays in Sessions without forcing Chat', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = await fixture(page, false, gate);
  try {
    await page.goto('/');
    await execute(page);
    await expect.poll(state.created).toBe(true);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByLabel('Primary').getByRole('button', { name: 'Sessions', exact: true }).click();
    const received = page.waitForResponse('**/api/plans/execute');
    release();
    await received;
    await expect(page.locator(`[data-session-id="${state.session.id}"]`)).toHaveCount(1);
    await expect(
      page.getByLabel('Primary').getByRole('button', { name: 'Sessions', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(state.launches()).toBe(1);
    expect(state.forbidden).toEqual([]);
  } finally {
    release();
  }
});
