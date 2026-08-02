/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';

async function openLocked(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: 'locked', publicOrigin: 'http://127.0.0.1:4173' }),
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Unlock relay' })).toBeVisible();
}

test('locked passkey login is usable at mobile size', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openLocked(page);
  const action = page.getByRole('button', { name: 'Sign in with a passkey' });
  await expect(action).toBeFocused();
  expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole('navigation')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(page.locator('.login')).toHaveCSS('animation-duration', '1e-05s');
  await page.screenshot({ path: 'test-results/auth/login-mobile.png', fullPage: true });
});

test('locked passkey login remains usable at 200% desktop font scale', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await openLocked(page);
  const action = page.getByRole('button', { name: 'Sign in with a passkey' });
  await expect(action).toBeFocused();
  expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole('navigation')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/auth/login-desktop-200.png', fullPage: true });
});
