/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const evidenceDirectory = '/tmp/gestalt-mobile-filesystem-tree-evidence';

test.beforeAll(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
});

const viewports = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
] as const;
const themes = ['light', 'dark'] as const;
const fontScales = [100, 200] as const;
const contexts = ['sessions', 'git'] as const;

async function openEvidence(
  page: Page,
  context: (typeof contexts)[number],
  theme: (typeof themes)[number],
  fontScale: (typeof fontScales)[number],
): Promise<{ consoleErrors: string[]; requestFailures: string[] }> {
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
  await page.goto(`/?tree-evidence=${context}`);
  await page.addStyleTag({ content: `html { font-size: ${fontScale}% !important; }` });
  const tree = page.getByRole('tree');
  await expect(tree).toBeVisible();
  await tree
    .getByRole('treeitem', { selected: true })
    .evaluate((item) => (item as HTMLElement).focus({ preventScroll: true }));
  return { consoleErrors, requestFailures };
}

test('supports deep folding, pointer selection, and ARIA tree keyboard interaction', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = await openEvidence(page, 'sessions', 'light', 100);
  const tree = page.getByRole('tree', { name: 'Session base' });
  const items = tree.getByRole('treeitem');

  await expect(items).toHaveCount(10);
  await expect(tree.locator('button:not([tabindex="-1"])')).toHaveCount(1);
  await tree.evaluate((element) => {
    const tabSentinel = document.createElement('button');
    tabSentinel.dataset.testid = 'before-tree';
    element.before(tabSentinel);
    tabSentinel.focus();
  });
  await page.keyboard.press('Tab');
  await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toBeFocused();
  await page.locator('[data-testid="before-tree"]').evaluate((element) => element.remove());
  await items.nth(0).focus();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(items.nth(9)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(items.nth(0)).toBeFocused();

  const collapse = page.getByRole('button', { name: 'Collapse dyne' });
  await collapse.click();
  await expect(items).toHaveCount(3);
  await page.getByRole('button', { name: 'Expand dyne' }).click();
  await expect(items).toHaveCount(10);

  const repository = tree.getByRole('treeitem', { name: /gestalt-mobile/ });
  await repository.click();
  await expect(repository).toHaveAttribute('aria-selected', 'true');
  expect(diagnostics).toEqual({ consoleErrors: [], requestFailures: [] });
});

for (const context of contexts) {
  for (const viewport of viewports) {
    for (const fontScale of fontScales) {
      for (const theme of themes) {
        test(`captures ${context} tree at ${viewport.width}x${viewport.height}, ${fontScale}% font, ${theme}`, async ({
          page,
        }) => {
          await page.setViewportSize(viewport);
          const diagnostics = await openEvidence(page, context, theme, fontScale);

          const dimensions = await page.locator('button').evaluateAll((buttons) =>
            buttons.map((button) => {
              const box = button.getBoundingClientRect();
              return {
                width: box.width,
                height: box.height,
                label: button.getAttribute('aria-label'),
              };
            }),
          );
          expect(dimensions.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);

          const overflow = await page.evaluate(() => ({
            document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            tree: (() => {
              const tree = document.querySelector<HTMLElement>('[role="tree"]');
              return tree ? tree.scrollWidth - tree.clientWidth : 1;
            })(),
          }));
          expect(overflow).toEqual({ document: 0, tree: 0 });

          const filename = `tree-${context}-${viewport.width}x${viewport.height}-font${fontScale}-${theme}.png`;
          await page.screenshot({
            path: `${evidenceDirectory}/${filename}`,
            fullPage: false,
          });
          expect(diagnostics).toEqual({ consoleErrors: [], requestFailures: [] });
        });
      }
    }
  }
}
