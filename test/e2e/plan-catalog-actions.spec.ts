/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';

test('refreshes only on Plan actions, keeps layout stable, and persists archiving across reload', async ({
  page,
}) => {
  await page.clock.install();
  await mockAuthenticatedStatus(page);
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: [
          { id: 'root', name: '/', relativePath: '.', isGitRepository: false, children: [] },
        ],
        profiles: [],
        sessions: [],
      }),
    }),
  );
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/sessions', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/skill-profiles', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"profiles":[]}' }),
  );
  const planName = 'group/repository/.gestalt/iterations/roadmap.org';
  let archived = false;
  let reads = 0;
  let hold = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/workspaces/root/plans', async (route) => {
    reads++;
    if (hold) await gate;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          planName,
          title: 'Working roadmap',
          previewAvailable: true,
          doneSteps: 2,
          totalSteps: 3,
          allDone: false,
          archived,
        },
        {
          planName: 'other/.gestalt/completed.org',
          title: 'Finished roadmap',
          previewAvailable: true,
          doneSteps: 3,
          totalSteps: 3,
          allDone: true,
        },
      ]),
    });
  });
  let archives = 0;
  await page.route(
    `**/api/workspaces/root/plans/${encodeURIComponent(planName)}/archive`,
    async (route) => {
      archives++;
      if (archives === 1)
        return route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: '{"code":"PLAN_ARCHIVE_UNAVAILABLE"}',
        });
      archived = true;
      return route.fulfill({ contentType: 'application/json', body: '{"archived":true}' });
    },
  );
  await page.goto('/');
  const navigation = page.getByLabel('Primary');
  const planTab = navigation.getByRole('button', { name: 'Plan', exact: true });
  await planTab.click();
  const open = page.getByRole('button', { name: 'Open Working roadmap', exact: true });
  await expect(open).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ORG Plans', exact: true })).toBeVisible();
  expect(reads).toBe(1);
  await page.clock.fastForward(20_000);
  expect(reads).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: '(updating…)' })).toHaveCount(0);
  const row = page.getByRole('listitem', { name: `Working roadmap (${planName})`, exact: true });
  const progress = row.getByRole('progressbar');
  await expect(progress).toHaveAttribute('value', '2');
  await expect(progress).toHaveAttribute('max', '3');
  await expect(row.getByText('2 / 3', { exact: true })).toBeVisible();
  await expect(row.getByText('group/repository', { exact: true })).toBeVisible();
  await expect(row.getByText('roadmap.org', { exact: true })).toBeVisible();
  await expect(row.getByText('iterations', { exact: true })).toHaveCount(0);

  for (const [name, width, height, font] of [
    ['desktop', 1280, 900, '100%'],
    ['mobile', 390, 844, '100%'],
    ['mobile-zoom', 320, 700, '200%'],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate((size) => {
      document.documentElement.style.fontSize = size;
    }, font);
    const geometry = await row.evaluate((element) => {
      const details = element.querySelector('.plan-details')!.getBoundingClientRect();
      const actions = element.querySelector('.plan-actions')!.getBoundingClientRect();
      return {
        detailsRight: details.right,
        actionsLeft: actions.left,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.actionsLeft).toBeGreaterThanOrEqual(geometry.detailsRight);
    await page.screenshot({ path: `test-results/org-plans-${name}.png`, fullPage: true });
  }
  const before = await row.boundingBox();
  hold = true;
  await planTab.click();
  await expect.poll(() => reads).toBe(2);
  const status = page.getByRole('status').filter({ hasText: '(updating…)' });
  await expect(status).toBeVisible();
  const header = await page.getByRole('heading', { name: 'ORG Plans', exact: true }).boundingBox();
  const indicator = await status.boundingBox();
  expect(indicator!.x).toBeGreaterThan(header!.x);
  expect(indicator!.y).toBeGreaterThanOrEqual(header!.y);
  expect(indicator!.y).toBeLessThan(header!.y + header!.height);
  expect((await row.boundingBox())!.y).toBe(before!.y);
  hold = false;
  release();
  await expect(status).toHaveCount(0);
  expect((await row.boundingBox())!.y).toBe(before!.y);

  const archive = row.getByRole('button', { name: 'Archive Working roadmap', exact: true });
  await archive.click();
  await expect(
    page.getByText('The plan could not be archived. Check that it is writable and try again.'),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Unfinished plans' })).toContainText(
    'Working roadmap',
  );
  await archive.click();
  const completed = page.getByRole('list', { name: 'Completed and archived plans' });
  await expect(completed).toContainText('Working roadmap');
  await expect(completed.getByRole('button', { name: 'Archive Working roadmap' })).toBeDisabled();
  await expect(completed.getByRole('button', { name: 'Open Working roadmap' })).toBeFocused();
  await expect(
    completed.getByRole('progressbar', { name: 'Completion for Working roadmap' }),
  ).toHaveAttribute('value', '2');
  await page.reload();
  await page.getByLabel('Primary').getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(completed).toContainText('Working roadmap');
  const previous = reads;
  await page.getByLabel('Primary').getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByLabel('Primary').getByRole('button', { name: 'Plan', exact: true }).click();
  await expect.poll(() => reads).toBe(previous + 1);
});
