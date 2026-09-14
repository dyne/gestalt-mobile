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
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: [], profiles: [], models: [], sessions: [] }),
    }),
  );
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/sessions', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/skill-profiles', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ profiles: [] }) }),
  );
  await page.route('**/api/maintenance/update-restart', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'UPDATE_RESTART_FAILED',
        message: 'Update service unavailable.',
      }),
    }),
  );
  await page.goto('/');
  await expect(page.getByLabel('Primary')).toBeVisible();
}

async function openNotifications(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open configuration' }).click();
  await page.getByRole('button', { name: 'Notifications' }).click();
  await expect(page.getByRole('heading', { name: 'Recent notifications' })).toBeFocused();
}

test('keeps dismissed notifications in browser-local recent history', async ({ page }) => {
  await openRelay(page);
  await page.getByRole('button', { name: 'Open configuration' }).click();
  await page.getByRole('button', { name: 'Update and restart' }).click();
  await page
    .getByRole('dialog', { name: 'Update Gestalt?' })
    .getByRole('button', { name: 'Update and restart' })
    .click();

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  const message = await alert.locator('.toast-copy > span').innerText();
  await page
    .getByRole('dialog', { name: 'Update Gestalt?' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  await alert.getByRole('button', { name: 'Dismiss error notification' }).click();
  await expect(alert).toHaveCount(0);

  await openNotifications(page);
  await expect(page.getByRole('list', { name: 'Recent notifications' })).toContainText(message);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('button', { name: 'Open configuration' })).toBeFocused();

  await page.reload();
  await openNotifications(page);
  await expect(page.getByRole('list', { name: 'Recent notifications' })).toContainText(message);
});
