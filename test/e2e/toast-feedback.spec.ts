/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import {
  evidenceFilename,
  evidenceFontScales,
  evidenceThemes,
  evidenceViewports,
  expectCleanThemeDiagnostics,
  expectNoHorizontalOverflow,
  openThemeEvidence,
} from './theme-evidence.js';

const evidenceDirectory = '/tmp/gestalt-mobile-toast-evidence';
const variants = ['error', 'stacked'] as const;

test.beforeAll(async () => mkdir(evidenceDirectory, { recursive: true }));
test.beforeEach(async ({ page }) => mockAuthenticatedStatus(page));

async function openEvidence(
  page: Page,
  variant: (typeof variants)[number],
  theme: (typeof evidenceThemes)[number],
  fontScale: (typeof evidenceFontScales)[number],
) {
  const diagnostics = await openThemeEvidence(page, {
    theme,
    fontScale,
    url: `/?toast-evidence=${variant}`,
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await page
    .getByRole('button', { name: 'Dismiss error notification' })
    .evaluate((button) => (button as HTMLElement).focus({ preventScroll: true }));
  return diagnostics;
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

test('announces feedback, is non-modal, keyboard-dismissible, and does not steal focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = await openEvidence(page, 'error', 'dyne-org', 100);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Clone failed.');
  await expect(alert).toHaveAttribute('aria-live', 'assertive');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.focus();
  await expect(prompt).toBeFocused();
  const dismiss = page.getByRole('button', { name: 'Dismiss error notification' });
  await dismiss.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expectCleanThemeDiagnostics(diagnostics);
});

for (const variant of variants) {
  for (const viewport of evidenceViewports) {
    for (const fontScale of evidenceFontScales) {
      for (const theme of evidenceThemes) {
        test(`captures ${variant} feedback at ${viewport.width}x${viewport.height}, ${fontScale}% font, ${theme}`, async ({
          page,
        }) => {
          await page.setViewportSize(viewport);
          const diagnostics = await openEvidence(page, variant, theme, fontScale);
          const alerts = page.getByRole('alert');
          const statuses = page.getByRole('status');
          await expect(alerts).toHaveCount(1);
          await expect(statuses).toHaveCount(variant === 'stacked' ? 1 : 0);
          await expect(alerts).toHaveAttribute('aria-live', 'assertive');
          if (variant === 'stacked') {
            await expect(statuses).toContainText('Cloned.');
            await expect(statuses).toHaveAttribute('aria-live', 'polite');
          }

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
          await expectNoHorizontalOverflow(page);

          const filename = evidenceFilename('toast', variant, viewport, fontScale, theme);
          await page.screenshot({ path: `${evidenceDirectory}/${filename}`, fullPage: false });
          expectCleanThemeDiagnostics(diagnostics);
        });
      }
    }
  }
}
