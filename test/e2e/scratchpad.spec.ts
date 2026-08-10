/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';

const session = {
  id: 'scratchpad-session',
  state: 'ready',
  threadId: 'scratchpad-thread',
  workspaceId: 'workspace-1',
  workspacePath: '/projects/scratchpad',
  profile: 'default',
  model: 'gpt-5.6-terra',
  activeTurnId: null,
};

async function openRelay(page: Page): Promise<void> {
  await mockAuthenticatedStatus(page);
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: [], profiles: [], sessions: [session] }),
    }),
  );
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/sessions', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify([session]) }),
  );
  await page.route('**/api/skill-profiles', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ profiles: [] }) }),
  );
  await page.route(`**/api/sessions/${session.id}/history`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ items: [], currentSequence: 0 }),
    }),
  );
  await page.route(`**/api/sessions/${session.id}/plan`, (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/workspaces/workspace-1/plans', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.routeWebSocket(/\/api\/sessions\/scratchpad-session\/events\?after=\d+/, () => {});
  await page.goto('/');
  await expect(page.getByLabel('Primary')).toBeVisible();
}

async function openScratchpad(page: Page) {
  const menu = page.getByRole('button', { name: 'Open configuration' });
  await menu.click();
  await page.getByRole('button', { name: 'Scratchpad', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Scratchpad' });
  await expect(dialog).toBeVisible();
  return { dialog, menu, text: dialog.getByLabel('Scratchpad text') };
}

test('scratchpad is persistent, mobile-safe, and reachable over every tab', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('scratchpad-e2e-initialized')) return;
    localStorage.removeItem('gestalt-mobile.scratchpad');
    sessionStorage.setItem('scratchpad-e2e-initialized', 'true');
  });
  await openRelay(page);

  const navigation = page.getByLabel('Primary');
  for (const [index, tab] of ['Sessions', 'Git', 'Chat', 'Plan'].entries()) {
    await navigation.getByRole('button', { name: tab }).click();
    await expect(navigation.getByRole('button', { name: tab })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const scratchpad = await openScratchpad(page);
    if (index === 0) await scratchpad.text.fill('Reusable fragment\nwith a second line');
    await expect(scratchpad.text).toHaveValue('Reusable fragment\nwith a second line');
    expect((await scratchpad.dialog.boundingBox())?.width).toBeLessThanOrEqual(375);
    const targetHeights = await scratchpad.dialog
      .locator('button, textarea')
      .evaluateAll((targets) => targets.map((target) => target.getBoundingClientRect().height));
    expect(targetHeights.every((height) => height >= 44)).toBe(true);
    await scratchpad.dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(scratchpad.menu).toBeFocused();
  }

  await page.reload();
  const reopened = await openScratchpad(page);
  await expect(reopened.text).toHaveValue('Reusable fragment\nwith a second line');
  await page.screenshot({ path: 'test-results/scratchpad/mobile.png', fullPage: true });
  await reopened.dialog.getByRole('button', { name: 'Clear' }).click();
  await expect(reopened.dialog.getByText('Clear the entire scratchpad?')).toBeVisible();
  await reopened.dialog.getByRole('button', { name: 'Keep text' }).click();
  await expect(reopened.text).toHaveValue('Reusable fragment\nwith a second line');
  await reopened.dialog.getByRole('button', { name: 'Clear' }).click();
  await reopened.dialog.getByRole('button', { name: 'Clear all' }).click();
  await expect(reopened.text).toHaveValue('');
});
