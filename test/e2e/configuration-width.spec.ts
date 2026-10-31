/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';

test('configuration stays compact and wraps long messages and paths at normal and enlarged text sizes', async ({
  page,
}, testInfo) => {
  await mockAuthenticatedStatus(page);
  const message = `Workspace discovery needs attention. ${'long-diagnostic-reference-'.repeat(18)}`;
  const status = {
    mode: 'auto',
    state: 'watching',
    root: `/workspace/${'long-repository-name-'.repeat(12)}`,
    message,
  };
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      json: {
        workspaces: [],
        profiles: [],
        sessions: [],
        xerj: status,
        versions: [{ id: 'xerj', label: 'XERJ', version: '1.0.0' }],
      },
    }),
  );
  await page.route('**/api/xerj', (route) => route.fulfill({ json: status }));
  await page.route('**/api/skill-profiles', (route) => route.fulfill({ json: { profiles: [] } }));
  await page.goto('/');
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const fontScale of [100, 200]) {
      await page.locator('html').evaluate((element, scale) => {
        element.style.fontSize = `${scale}%`;
      }, fontScale);
      await page.getByRole('button', { name: 'Open configuration' }).click();
      const panel = page.locator('#configuration-panel');
      await expect(panel).toBeVisible();
      const longMessage = panel.getByText(message, { exact: true });
      await longMessage.scrollIntoViewIfNeeded();
      await expect(longMessage).toBeVisible();
      const metrics = await panel.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          width: bounds.width,
          fits: element.scrollWidth <= element.clientWidth,
          documentFits: document.documentElement.scrollWidth <= innerWidth,
          textFits: [...element.querySelectorAll('p, dt, .xerj-root')].every(
            (text) => text.scrollWidth <= text.clientWidth,
          ),
        };
      });
      expect(metrics.left).toBeGreaterThanOrEqual(0);
      expect(metrics.right).toBeLessThanOrEqual(width);
      expect(metrics.fits).toBe(true);
      expect(metrics.documentFits).toBe(true);
      expect(metrics.textFits).toBe(true);
      if (width === 1440) expect(metrics.width).toBeLessThanOrEqual(fontScale === 100 ? 400 : 800);
      await page.screenshot({
        path: testInfo.outputPath(`configuration-${width}-font${fontScale}.png`),
      });
      const quit = panel.getByRole('button', { name: 'Quit', exact: true });
      await quit.focus();
      await expect(quit).toBeInViewport();
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
    }
  }
});
