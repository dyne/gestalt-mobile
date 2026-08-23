/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, test, type Page } from '@playwright/test';

const devices = [
  { id: 'phone', nickname: '<safe phone>', createdAt: '2026-08-01T00:00:00.000Z', current: true },
  {
    id: 'laptop',
    nickname: 'Laptop',
    createdAt: '2026-08-02T00:00:00.000Z',
    lastUsedAt: '2026-08-03T00:00:00.000Z',
    current: false,
  },
];

async function openDevices(page: Page, fontScale = 100): Promise<void> {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'authenticated',
        publicOrigin: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 4173}`,
      }),
    }),
  );
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: [],
        profiles: [],
        sessions: [],
        capabilities: { approvals: true, userInput: true, git: true, protocolCompatible: true },
      }),
    }),
  );
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/skill-profiles', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ profiles: [] }) }),
  );
  await page.route('**/api/auth/devices', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ devices }) }),
  );
  await page.route('**/api/auth/enrollment-tickets', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ticket: 'ticket-only-client-memory',
        url: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 4173}/#enroll=ticket-only-client-memory`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    }),
  );
  await page.route('**/api/auth/enrollment-tickets/current', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: route.request().method() === 'DELETE' ? 'none' : 'pending' }),
    }),
  );
  await page.goto('/');
  await page.addStyleTag({ content: `html { font-size: ${fontScale}% !important; }` });
  const menu = page.getByRole('button', { name: 'Open configuration' });
  await menu.click();
  await page.getByRole('button', { name: 'Authorized devices' }).click();
  await expect(page.getByRole('heading', { name: 'Authorized devices' })).toBeVisible();
}

async function assertUsable(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const targets = await page
    .locator('.devices button, .devices input')
    .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
  expect(targets.every((height) => height >= 44)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await expect(page.locator('.devices')).toHaveCSS('animation-duration', '1e-05s');
}

test('authorized devices is mobile-safe and returns focus to the burger menu', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openDevices(page);
  await assertUsable(page);
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  await page.screenshot({ path: 'test-results/auth/devices-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('button', { name: 'Open configuration' })).toBeFocused();
});

test('shows a native named revoke confirmation and QR matching the copyable fragment link', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openDevices(page);
  await page.getByRole('button', { name: 'Revoke' }).nth(1).click();
  await expect(page.getByRole('dialog', { name: 'Revoke authorized device?' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep device' }).click();
  await page.getByRole('button', { name: 'Create enrollment link' }).click();
  await expect(page.getByRole('img', { name: 'QR code for the enrollment link' })).toBeVisible();
  await expect(page.getByLabel('Enrollment link')).toHaveValue(
    /#enroll=ticket-only-client-memory$/,
  );
  expect((await page.locator('.devices').innerText()).includes('ticket-only-client-memory')).toBe(
    false,
  );
  await page.screenshot({ path: 'test-results/auth/add-device-qr.png', fullPage: true });
});

test('authorized devices remains unclipped at desktop 200% font scale', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openDevices(page, 200);
  await assertUsable(page);
  await page.screenshot({ path: 'test-results/auth/devices-desktop-200.png', fullPage: true });
});
