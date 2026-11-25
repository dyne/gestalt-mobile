/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture } from './chat-relay-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

test('navigation, menu and composer render references to a single external SVG', async ({
  page,
}) => {
  const spriteUrls = new Set<string>();
  page.on('response', (response) => {
    if (
      response.headers()['content-type']?.startsWith('image/svg+xml') &&
      response.url().includes('ui-icons')
    ) {
      spriteUrls.add(response.url().split('#')[0]!);
    }
  });
  await mockAuthenticatedStatus(page);
  const fixture = new ChatRelayFixture(page);
  await fixture.install([
    {
      id: 's',
      state: 'ready',
      threadId: 't',
      workspaceId: 'w',
      workspacePath: '/workspace',
      profile: 'default',
      activeTurnId: null,
      pendingInteractions: [],
    },
  ]);
  fixture.snapshot('s', chatSnapshot({}));
  await page.goto('/');
  const menu = page.getByRole('button', { name: 'Open configuration' });
  await menu.click();
  const bell = page.getByRole('button', { name: 'Notifications' }).locator('use');
  await expect
    .poll(() => bell.evaluate((el: SVGUseElement) => el.getBBox().width))
    .toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const upload = page.getByRole('button', { name: 'Upload files', exact: true }).locator('use');
  await expect
    .poll(() => upload.evaluate((el: SVGUseElement) => el.getBBox().width))
    .toBeGreaterThan(0);
  await page.getByRole('textbox', { name: 'Prompt' }).fill('Hello');
  const send = page.getByRole('button', { name: 'Send prompt', exact: true }).locator('use');
  await expect(send).toHaveAttribute('href', /#send$/);
  await expect
    .poll(() => send.evaluate((el: SVGUseElement) => el.getBBox().width))
    .toBeGreaterThan(0);
  const urls = await page
    .locator('svg.ui-icon use')
    .evaluateAll((uses) =>
      uses.map((use) => new URL(use.getAttribute('href')!, location.href).href.split('#')[0]),
    );
  expect(spriteUrls.size).toBe(1);
  expect(new Set(urls)).toEqual(spriteUrls);
  await expect(page.locator('svg.ui-icon :is(path,circle,symbol)')).toHaveCount(0);
});
