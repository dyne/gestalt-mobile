/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture } from './chat-relay-fixture.js';
import { captureMenuTarget } from './menu-evidence.js';
import { expectCleanThemeDiagnostics, openThemeEvidence } from './theme-evidence.js';

// Incumbent menu evidence, before adding the cleanup action. No maintenance request runs.
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  for (const fontScale of [100, 200] as const) {
    test(`Clean TMP incumbent menu baseline ${viewport.width}x${viewport.height} font${fontScale}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await mockAuthenticatedStatus(page);
      const fixture = new ChatRelayFixture(page);
      await fixture.install([]);
      await page.route('**/api/skill-profiles', (route) =>
        route.fulfill({ json: { profiles: [] } }),
      );
      await page.route('**/api/session-models/*', (route) =>
        route.fulfill({ json: { models: ['gpt-6.1-sol', 'gpt-5.6-terra'] } }),
      );
      await page.route('**/api/sessions/*/plan', (route) => route.fulfill({ status: 204 }));
      const diagnostics = await openThemeEvidence(page, {
        theme: 'dyne-org',
        fontScale,
        url: '/',
      });
      await page.locator('html').evaluate((element, scale) => {
        element.style.setProperty('font-size', `${scale}%`, 'important');
      }, fontScale);
      await expect
        .poll(() => page.locator('html').evaluate((element) => getComputedStyle(element).fontSize))
        .toBe(`${16 * (fontScale / 100)}px`);
      expect(
        await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
      ).toBe(true);

      const trigger = page.getByRole('button', { name: 'Open configuration', exact: true });
      const menu = page.locator('#configuration-panel');
      await trigger.focus();
      await expect(trigger).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(menu).toBeVisible();
      const appearance = menu.getByRole('combobox', { name: 'Appearance', exact: true });
      // Use the actual native popover's keyboard sequence; no simulated menu focus/CSS.
      for (
        let index = 0;
        index < 20 && !(await appearance.evaluate((el) => el === document.activeElement));
        index++
      ) {
        await page.keyboard.press('Tab');
      }
      await expect(appearance).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath('menu-incumbent-top.png') });

      const upgrade = menu.getByRole('button', { name: 'Upgrade', exact: true });
      for (
        let index = 0;
        index < 20 && !(await upgrade.evaluate((el) => el === document.activeElement));
        index++
      ) {
        await page.keyboard.press('Tab');
      }
      const geometry = await captureMenuTarget(
        page,
        upgrade,
        testInfo,
        'menu-incumbent-maintenance-focus',
        { control: true, focused: true },
      );
      await page.keyboard.press('Escape');
      await expect(menu).not.toBeVisible();
      await expect(trigger).toBeFocused();
      await expect(page.getByRole('alert')).toHaveCount(0);
      expectCleanThemeDiagnostics(diagnostics);
      await testInfo.attach('menu-baseline-diagnostics', {
        body: JSON.stringify({ viewport, fontScale, reducedMotion: true, geometry, diagnostics }),
        contentType: 'application/json',
      });
    });
  }
}
