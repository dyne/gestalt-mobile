/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { mockAuthenticatedStatus } from './auth-fixture.js';

const output = '/tmp/gestalt-mobile-activity-evidence';
for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
]) {
  for (const theme of ['light', 'dark']) {
    for (const scale of viewport.width === 320 ? [1, 2] : [1])
      test(`activity evidence is keyboard-operable and overflow-free at ${viewport.width} ${theme} ${scale}x`, async ({
        page,
      }) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await mockAuthenticatedStatus(page);
        await page.setViewportSize(viewport);
        await page.goto('/?activity-evidence=true');
        await page.emulateMedia({
          colorScheme: theme as 'light' | 'dark',
          reducedMotion: 'reduce',
        });
        await page.evaluate(
          (value) => (document.documentElement.style.fontSize = `${value * 100}%`),
          scale,
        );
        await expect(page.getByText('Supervisor: waiting for child').first()).toBeVisible();
        for (const state of [
          'working',
          'awaitingAgent',
          'awaitingHuman',
          'blocked',
          'idle',
          'disconnected',
        ])
          await expect(page.locator(`[data-state="${state}"]`).first()).toBeVisible();
        await page.keyboard.press('Tab');
        await expect(page.locator('summary').first()).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.getByText('α worker').first()).toBeVisible();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        expect(errors).toEqual([]);
        await mkdir(output, { recursive: true });
        await page.screenshot({
          path: `${output}/activity-${viewport.width}-${theme}-${scale}x.png`,
          fullPage: true,
        });
      });
  }
}
