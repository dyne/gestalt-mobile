/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';

test('the relay exposes an installable standalone web app', async ({ page, request }) => {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: 'bootstrap', publicOrigin: 'http://127.0.0.1:4173' }),
    }),
  );

  await page.goto('/');

  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#141414');

  const manifestResponse = await request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBe(true);
  expect(await manifestResponse.json()).toMatchObject({
    id: '/',
    name: 'Gestalt Mobile',
    short_name: 'Gestalt',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    icons: [
      { sizes: '192x192', type: 'image/png', purpose: 'any' },
      { sizes: '512x512', type: 'image/png', purpose: 'any' },
      { sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });

  for (const icon of [
    '/icons/gestalt-mobile-192.png',
    '/icons/gestalt-mobile-512.png',
    '/icons/gestalt-mobile-maskable-512.png',
  ]) {
    const iconResponse = await request.get(icon);
    expect(iconResponse.ok()).toBe(true);
    expect(iconResponse.headers()['content-type']).toBe('image/png');
  }

  const workerPath = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return new URL(registration.active?.scriptURL ?? '').pathname;
  });
  expect(workerPath).toBe('/service-worker.js');
});
