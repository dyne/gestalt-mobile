/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import {
  executePlanName,
  installExecuteFixture,
  openExecuteEntry,
} from './execute-plan-fixture.js';

const source =
  '#+TITLE: Original roadmap\r\n# Preserve this comment and Ω.\r\n* Notes\r\n  Keep spacing.\r\n';
const filename = 'Long roadmap plan.org';
const headers = {
  'content-type': 'text/plain; charset=utf-8',
  'content-disposition': "attachment; filename*=UTF-8''Long%20roadmap%20plan.org",
};

for (const renderer of ['supervised', 'org-source'] as const) {
  for (const width of [320, 1280]) {
    test(`downloads original Org source beside Execute in the ${renderer} view at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      const fixture = await installExecuteFixture(page, { entry: 'catalog', renderer });
      await page.route('**/api/plans/download', async (route) => {
        expect(route.request().postDataJSON()).toEqual({
          kind: 'workspace',
          workspaceId: 'root',
          planName: executePlanName,
        });
        await route.fulfill({ headers, body: source });
      });
      await page.goto('/');
      await openExecuteEntry(page, 'catalog');
      const downloadButton = page.getByRole('button', { name: 'Download Org file' });
      const executeButton = page.getByRole('button', { name: 'Execute', exact: true });
      await expect(downloadButton).toBeInViewport();
      await expect(executeButton).toBeInViewport();
      const bounds = await Promise.all([downloadButton.boundingBox(), executeButton.boundingBox()]);
      expect(Math.abs(bounds[0]!.y - bounds[1]!.y)).toBeLessThan(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: testInfo.outputPath('plan-controls.png') });
      const downloaded = page.waitForEvent('download');
      await downloadButton.click();
      const download = await downloaded;
      expect(download.suggestedFilename()).toBe(filename);
      const path = testInfo.outputPath(filename);
      await download.saveAs(path);
      expect(await readFile(path, 'utf8')).toBe(source);
      expect(fixture.state.launchRequests).toHaveLength(0);
      await expect(downloadButton).toBeEnabled();
    });
  }
}

test('downloads a retained plan after a failed attempt and shows the shared error toast', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  const fixture = await installExecuteFixture(page, { entry: 'retained' });
  let attempts = 0;
  await page.route('**/api/plans/download', async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      kind: 'retained-session',
      sessionId: 'source-session',
    });
    if (++attempts === 1) return route.fulfill({ status: 404, json: { code: 'PLAN_NOT_FOUND' } });
    await route.fulfill({ headers, body: source });
  });
  await page.goto('/');
  await openExecuteEntry(page, 'retained');
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  const button = page.getByRole('button', { name: 'Download Org file' });
  await button.click();
  await expect(page.getByText('Could not download the Org file. Try again.')).toBeVisible();
  await expect(button).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('retained-plan-controls-200.png') });
  const downloaded = page.waitForEvent('download');
  await button.click();
  expect((await downloaded).suggestedFilename()).toBe(filename);
  expect(fixture.state.launchRequests).toHaveLength(0);
});
