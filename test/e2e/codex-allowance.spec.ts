/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { expectNoHorizontalOverflow } from './theme-evidence.js';
import { THEME_STORAGE_KEY } from '../../src/client/features/theme/theme-registry.js';

async function install(page: Page) {
  await mockAuthenticatedStatus(page);
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({ json: { workspaces: [], profiles: [], sessions: [] } }),
  );
  await page.route('**/api/sessions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/sessions/recent-threads', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/skill-profiles', (route) =>
    route.fulfill({ json: { profiles: [], defaultProfile: null } }),
  );
}

test('saves Use when over and logs a background redemption as information', async ({ page }) => {
  await install(page);
  await page.clock.install();
  const resets: { id: string; occurredAt: number }[] = [];
  const saves: boolean[] = [];
  let enabled = false;
  await page.route('**/api/codex/allowance', (route) =>
    route.fulfill({
      json: { weeklyRemainingPercent: 0, weeklyResetsAt: null, resetsAvailable: 2 },
    }),
  );
  await page.route('**/api/codex/allowance/auto-reset', (route) => {
    if (route.request().method() === 'PUT') {
      enabled = route.request().postDataJSON().enabled as boolean;
      saves.push(enabled);
    }
    return route.fulfill({ json: { enabled, resets } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  const checkbox = page.getByRole('checkbox', { name: 'Use when over' });
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).not.toBeChecked();
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  expect(saves).toEqual([true]);
  await page.getByLabel('Primary').getByRole('button', { name: 'Git', exact: true }).click();
  resets.push({ id: 'reset-one', occurredAt: Date.now() });
  await page.clock.fastForward(15_001);
  const message = 'Gestalt used a reset credit for the Codex weekly allowance.';
  await expect(page.getByRole('status').filter({ hasText: message })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: message })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Open configuration' }).click();
  await page.getByRole('button', { name: 'Notifications' }).click();
  const history = page.getByRole('list', { name: 'Recent notifications' });
  await expect(history.getByText(message, { exact: true })).toHaveCount(1);
});

for (const [width, theme] of [
  [320, 'minimal-light'],
  [390, 'minimal-dark'],
  [1024, 'dyne-org'],
] as const) {
  test(`Sessions shows weekly allowance, reset date and credits at ${width}px in ${theme}`, async ({
    page,
  }, testInfo) => {
    const now = new Date('2026-10-18T08:00:00Z');
    await page.clock.setFixedTime(now);
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(({ key, theme }) => localStorage.setItem(key, theme), {
      key: THEME_STORAGE_KEY,
      theme,
    });
    await install(page);
    await page.route('**/api/codex/allowance', (route) =>
      route.fulfill({
        json: {
          weeklyRemainingPercent: 63,
          weeklyResetsAt: now.getTime() / 1000 + 6 * 86_400 + 11 * 3_600,
          resetsAvailable: 2,
        },
      }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Sessions', exact: true }).click();
    const summary = page.getByRole('region', { name: 'Codex allowance' });
    await expect(summary).toContainText('63% left');
    await expect(summary).toContainText('Resets in 6 days 11 hours');
    await expect(summary).toContainText('2 available');
    await expect(summary.getByRole('progressbar')).toHaveAttribute('value', '63');
    await expect(summary).toBeInViewport();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`allowance-${width}.png`) });
  });
}

test('unavailable account data is distinct from an exhausted allowance', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  const summary = page.getByRole('region', { name: 'Codex allowance' });
  await expect(summary).toContainText('Unavailable');
  await expect(summary.getByRole('progressbar')).toHaveCount(0);
  await page.route('**/api/codex/allowance', (route) =>
    route.fulfill({
      json: {
        weeklyRemainingPercent: 0,
        weeklyResetsAt: Math.floor(Date.now() / 1000) - 5,
        resetsAvailable: 0,
      },
    }),
  );
  await page.reload();
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await expect(summary).toContainText('0% left');
  await expect(summary).toContainText('0 available');
  await expect(summary).toContainText('Reset due');
});
