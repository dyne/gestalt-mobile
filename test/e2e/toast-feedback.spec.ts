/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const evidenceDirectory = '/tmp/gestalt-mobile-toast-evidence';
const viewports = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
] as const;
const themes = ['light', 'dark'] as const;
const fontScales = [100, 200] as const;
const variants = ['error', 'stacked'] as const;

test.beforeAll(async () => mkdir(evidenceDirectory, { recursive: true }));

async function openEvidence(
  page: Page,
  variant: (typeof variants)[number],
  theme: (typeof themes)[number],
  fontScale: (typeof fontScales)[number],
) {
  const consoleErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => requestFailures.push(request.url()));
  await page.addInitScript(
    ({ selectedTheme }) => localStorage.setItem('gestalt-mobile.theme', selectedTheme),
    { selectedTheme: theme },
  );
  await page.goto(`/?toast-evidence=${variant}`);
  await page.addStyleTag({ content: `html { font-size: ${fontScale}% !important; }` });
  await expect(page.getByRole('alert')).toBeVisible();
  await page
    .getByRole('button', { name: 'Dismiss error notification' })
    .evaluate((button) => (button as HTMLElement).focus({ preventScroll: true }));
  return { consoleErrors, requestFailures };
}

type Box = { x: number; y: number; width: number; height: number };

function intersects(first: Box, second: Box): boolean {
  return !(
    first.x + first.width <= second.x ||
    first.x >= second.x + second.width ||
    first.y + first.height <= second.y ||
    first.y >= second.y + second.height
  );
}

async function boxesOverlap(first: Locator, second: Locator): Promise<boolean> {
  const [firstBox, secondBox] = await Promise.all([first.boundingBox(), second.boundingBox()]);
  if (!firstBox || !secondBox) return true;
  return intersects(firstBox, secondBox);
}

test('is non-modal, keyboard-dismissible, and does not steal focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = await openEvidence(page, 'error', 'light', 100);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.focus();
  await expect(prompt).toBeFocused();
  const dismiss = page.getByRole('button', { name: 'Dismiss error notification' });
  await dismiss.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(diagnostics).toEqual({ consoleErrors: [], requestFailures: [] });
});

for (const variant of variants) {
  for (const viewport of viewports) {
    for (const fontScale of fontScales) {
      for (const theme of themes) {
        test(`captures ${variant} feedback at ${viewport.width}x${viewport.height}, ${fontScale}% font, ${theme}`, async ({
          page,
        }) => {
          await page.setViewportSize(viewport);
          const diagnostics = await openEvidence(page, variant, theme, fontScale);
          const alerts = page.getByRole('alert');
          const statuses = page.getByRole('status');
          await expect(alerts).toHaveCount(1);
          await expect(statuses).toHaveCount(variant === 'stacked' ? 1 : 0);

          const dismiss = page.getByRole('button', { name: 'Dismiss error notification' });
          const dimensions = await dismiss.boundingBox();
          expect(dimensions?.width).toBeGreaterThanOrEqual(44);
          expect(dimensions?.height).toBeGreaterThanOrEqual(44);

          for (const toast of await page.locator('.toast').all()) {
            expect(await boxesOverlap(toast, page.getByRole('textbox', { name: 'Prompt' }))).toBe(
              false,
            );
            expect(
              await boxesOverlap(
                toast,
                page.getByRole('navigation', { name: 'Primary evidence navigation' }),
              ),
            ).toBe(false);
          }
          const overflow = await page.evaluate(() => ({
            amount: document.documentElement.scrollWidth - window.innerWidth,
            offenders: [...document.querySelectorAll<HTMLElement>('body *')]
              .map((element) => ({
                name: `${element.tagName.toLowerCase()}.${element.className}`,
                box: element.getBoundingClientRect().toJSON(),
              }))
              .filter(({ box }) => box.left < -0.5 || box.right > window.innerWidth + 0.5)
              .slice(0, 5),
          }));
          expect(overflow.offenders).toEqual([]);

          const filename = `toast-${variant}-${viewport.width}x${viewport.height}-font${fontScale}-${theme}.png`;
          await page.screenshot({ path: `${evidenceDirectory}/${filename}`, fullPage: false });
          expect(diagnostics).toEqual({ consoleErrors: [], requestFailures: [] });
        });
      }
    }
  }
}
