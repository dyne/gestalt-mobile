/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';

async function openRelay(page: Page): Promise<void> {
  await mockAuthenticatedStatus(page);
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      json: { workspaces: [], profiles: [], models: { codex: [], kimi: [] }, sessions: [] },
    }),
  );
  for (const path of ['sessions', 'sessions/recent-threads']) {
    await page.route(`**/api/${path}`, (route) => route.fulfill({ json: [] }));
  }
  await page.route('**/api/skill-profiles', (route) => route.fulfill({ json: { profiles: [] } }));
  await page.goto('/');
  await expect(page.getByLabel('Primary')).toBeVisible();
  await page.getByRole('button', { name: 'Open configuration' }).click();
  await page.getByRole('button', { name: 'Upgrade', exact: true }).click();
}

for (const width of [390, 1280]) {
  test(`upgrade confirms and reloads after restart at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    let starts = 0;
    let reads = 0;
    await page.route('**/api/maintenance/upgrade', async (route) => {
      if (route.request().method() === 'POST') {
        starts += 1;
        await route.fulfill({ status: 202, json: { instanceId: 'old', phase: 'updating' } });
      } else {
        reads += 1;
        if (reads === 2) await route.abort();
        else
          await route.fulfill({ json: { instanceId: reads >= 3 ? 'new' : 'old', phase: 'idle' } });
      }
    });
    await openRelay(page);
    const dialog = page.getByRole('dialog', { name: 'Upgrade Gestalt?' });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    expect(starts).toBe(0);
    await page.screenshot({ path: info.outputPath('upgrade-confirmation.png') });
    const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
    await dialog.getByRole('button', { name: 'Upgrade and restart' }).click();
    await expect(dialog.getByRole('button', { name: 'Upgrading…' })).toBeDisabled();
    await expect(dialog.getByRole('status')).toContainText('reconnect');
    await reloaded;
    await expect(page.getByLabel('Primary')).toBeVisible();
    expect(starts).toBe(1);
    expect(reads).toBe(3);
  });
}

test('upgrade failures use the shared toast and restore the controls', async ({ page }) => {
  await page.route('**/api/maintenance/upgrade', (route) =>
    route.fulfill({ status: 503, json: { code: 'UPGRADE_FAILED' } }),
  );
  await openRelay(page);
  const dialog = page.getByRole('dialog', { name: 'Upgrade Gestalt?' });
  await dialog.getByRole('button', { name: 'Upgrade and restart' }).click();
  await expect(page.getByRole('alert')).toContainText('upgrade');
  await expect(dialog.getByRole('button', { name: 'Upgrade and restart' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Open configuration' })).toBeFocused();
});
