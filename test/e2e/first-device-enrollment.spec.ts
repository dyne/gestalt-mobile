/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';

async function openBootstrap(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: 'bootstrap', publicOrigin: 'http://127.0.0.1:4173' }),
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Authorize the first device' })).toBeVisible();
}

test('first-device enrollment is usable at mobile size', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openBootstrap(page);
  const nickname = page.getByLabel('Device nickname');
  await nickname.focus();
  await expect(nickname).toBeFocused();
  await expect(page.getByRole('link', { name: /bootstrap=1/ })).toBeVisible();
  const warning = page.locator('.warning');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(
    /anyone who can reach an empty relay instance could claim\s+first-device access/i,
  );
  for (const control of [
    nickname,
    page.getByRole('button', { name: 'Authorize this device' }),
    page.getByRole('button', { name: 'Copy setup link' }),
  ])
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(
    await page
      .locator('.enrollment')
      .evaluate((element) => element.getBoundingClientRect().width === window.innerWidth),
  ).toBe(true);
  expect(
    await page
      .locator('.enrollment')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe('rgb(244, 240, 232)');
  await expect(page.locator('.enrollment')).toHaveCSS('animation-duration', '1e-05s');
  await page.screenshot({ path: 'test-results/auth/first-run-mobile.png', fullPage: true });
});

test('first-device enrollment remains usable at 200% font scale on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await openBootstrap(page);
  const nickname = page.getByLabel('Device nickname');
  await nickname.focus();
  await expect(nickname).toBeFocused();
  await expect(page.getByRole('link', { name: /bootstrap=1/ })).toBeVisible();
  expect(
    (await page.getByRole('button', { name: 'Authorize this device' }).boundingBox())?.height,
  ).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/auth/first-run-desktop-200.png', fullPage: true });
});
