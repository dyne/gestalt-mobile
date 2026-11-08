/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { writeFile } from 'node:fs/promises';
import { expect, test, type Page, type Locator } from '@playwright/test';
import { openThemeEvidence } from './theme-evidence.js';
import {
  installExecuteFixture,
  openExecuteEntry,
  executeSourcePath,
  type ExecuteRenderer,
} from './execute-plan-fixture.js';

const configurations = [
  { width: 390, height: 844, fontScale: 100 as const },
  { width: 1280, height: 900, fontScale: 100 as const },
  { width: 320, height: 568, fontScale: 200 as const },
];
async function target(control: Locator) {
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  return box!;
}
async function noOverflow(page: Page) {
  const result = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    rootFont: getComputedStyle(document.documentElement).fontSize,
  }));
  expect(result.scroll).toBeLessThanOrEqual(result.width + 1);
  return result;
}

async function viewportBounds(page: Page) {
  const modal = page.getByRole('dialog');
  return {
    viewport: page.viewportSize(),
    scroll: await page.evaluate(() => ({ x: scrollX, y: scrollY })),
    navigation: await page.getByLabel('Primary').boundingBox(),
    modal:
      (await modal.count()) && (await modal.isVisible())
        ? await modal.evaluate((element) => ({
            top: element.getBoundingClientRect().top,
            left: element.getBoundingClientRect().left,
            width: element.clientWidth,
            height: element.clientHeight,
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
          }))
        : null,
  };
}

for (const renderer of ['supervised', 'org-source'] as ExecuteRenderer[]) {
  for (const theme of ['minimal-light', 'minimal-dark'] as const) {
    for (const configuration of configurations) {
      test(`Execute visual ${renderer} ${theme} ${configuration.width}x${configuration.height} ROOT${configuration.fontScale}`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize(configuration);
        const entry = renderer === 'supervised' ? 'catalog' : 'linked';
        const { state } = await installExecuteFixture(page, { entry, renderer });
        await openThemeEvidence(page, { theme, fontScale: configuration.fontScale, url: '/' });
        await expect
          .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize))
          .toBe(configuration.fontScale === 200 ? '32px' : '16px');
        await openExecuteEntry(page, entry);
        const header = page.locator(
          renderer === 'supervised' ? '.plan > header' : '.org-document > header',
        );
        const execute = page.getByRole('button', { name: 'Execute', exact: true });
        const close = page.getByRole('button', { name: 'Close plan and return to list' });
        const path = header.locator('code');
        await expect(path).toHaveText(executeSourcePath);
        const copy = page.getByRole('button', { name: 'Copy Org file path' });
        await target(copy);
        await copy.click();
        await expect
          .poll(() => page.evaluate(() => (window as Window & { copiedPath?: string }).copiedPath))
          .toBe(executeSourcePath);
        await page.getByRole('button', { name: 'Dismiss success notification' }).click();
        await target(close);
        const actionBox = await target(execute);
        const closeBox = (await close.boundingBox())!;
        expect(
          actionBox.x >= closeBox.x + closeBox.width ||
            actionBox.x + actionBox.width <= closeBox.x ||
            actionBox.y >= closeBox.y + closeBox.height ||
            actionBox.y + actionBox.height <= closeBox.y,
        ).toBe(true);
        const enabledStyle = await execute.evaluate((button) => ({
          color: getComputedStyle(button).color,
          background: getComputedStyle(button).backgroundColor,
          opacity: getComputedStyle(button).opacity,
        }));
        const headerMetrics = await noOverflow(page);
        await page.evaluate(() => scrollTo(0, 0));
        const headerView = {
          ...(await viewportBounds(page)),
          heading: await header
            .getByRole('heading', { name: 'Project roadmap', exact: true })
            .boundingBox(),
          path: await path.boundingBox(),
          close: await close.boundingBox(),
          action: await execute.boundingBox(),
        };
        if (configuration.width === 320) {
          const headerBox = (await header.boundingBox())!;
          const pathBox = (await path.boundingBox())!;
          expect(pathBox.width).toBeGreaterThanOrEqual(headerBox.width / 2);
        }
        await page.screenshot({ path: testInfo.outputPath('header.png'), fullPage: false });
        await execute.scrollIntoViewIfNeeded();
        const actionView = { ...(await viewportBounds(page)), action: await execute.boundingBox() };
        await page.screenshot({ path: testInfo.outputPath('header-action.png'), fullPage: false });
        await execute.click();
        await expect(page.getByRole('dialog', { name: 'Execute plan' })).toBeVisible();
        const select = page.getByRole('combobox', { name: 'Supervisor Skill profile' });
        await target(select);
        if (renderer === 'org-source') await select.selectOption('supervisor');
        const ok = page.getByRole('button', { name: 'OK', exact: true });
        await expect(ok).toBeEnabled();
        await target(ok);
        await target(page.getByRole('button', { name: 'Cancel', exact: true }));
        const dialogMetrics = await noOverflow(page);
        const modalMetrics = await page.getByRole('dialog').evaluate((element) => ({
          width: element.clientWidth,
          scroll: element.scrollWidth,
          height: element.clientHeight,
          maxHeight: innerHeight,
        }));
        expect(modalMetrics.scroll).toBeLessThanOrEqual(modalMetrics.width + 1);
        expect(modalMetrics.height).toBeLessThanOrEqual(modalMetrics.maxHeight);
        const modal = page.getByRole('dialog');
        const heading = modal.getByRole('heading', { name: 'Execute plan' });
        await modal.evaluate((element) => {
          element.scrollTop = 0;
        });
        await expect(heading).toBeInViewport({ ratio: 1 });
        expect(
          await heading.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        ).toBe(true);
        const dialogTopView = {
          ...(await viewportBounds(page)),
          heading: await heading.boundingBox(),
          profile: await select.boundingBox(),
          ok: await ok.boundingBox(),
        };
        await page.screenshot({ path: testInfo.outputPath('dialog.png'), fullPage: false });
        await modal.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await expect(select).toBeInViewport({ ratio: 1 });
        await expect(ok).toBeInViewport({ ratio: 1 });
        const selectedText = await select.evaluate((element: HTMLSelectElement) => {
          const style = getComputedStyle(element);
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d')!;
          context.font = style.font;
          return {
            textWidth: context.measureText(element.selectedOptions[0]!.textContent ?? '').width,
            available:
              element.clientWidth -
              parseFloat(style.paddingLeft) -
              parseFloat(style.paddingRight) -
              24,
          };
        });
        expect(selectedText.textWidth).toBeLessThanOrEqual(selectedText.available);
        const dialogControlView = {
          ...(await viewportBounds(page)),
          profile: await select.boundingBox(),
          ok: await ok.boundingBox(),
          cancel: await page.getByRole('button', { name: 'Cancel', exact: true }).boundingBox(),
          selectedText,
        };
        await page.screenshot({
          path: testInfo.outputPath('dialog-controls.png'),
          fullPage: false,
        });
        await ok.click();
        await expect(
          page.getByLabel('Primary').getByRole('button', { name: 'Chat', exact: true }),
        ).toHaveAttribute('aria-pressed', 'true');
        await expect(
          page.getByText('Supervise the exact project roadmap with the Org plan workflow.'),
        ).toBeVisible();
        const sessionMetrics = await noOverflow(page);
        const sessionView = await viewportBounds(page);
        await page.screenshot({ path: testInfo.outputPath('session.png'), fullPage: false });
        expect(state.launchRequests).toHaveLength(1);
        expect(state.launchRequests[0]!.skillProfile).toBe(
          renderer === 'org-source' ? 'supervisor' : '',
        );
        expect(state.opens).toEqual(entry === 'linked' ? ['source-session'] : []);
        expect(state.toggles).toEqual([]);
        // Plain Org uses the same full viewer, path/copy row and neutral disabled action.
        await page.getByLabel('Primary').getByRole('button', { name: 'Plan', exact: true }).click();
        const viewerClose = page.getByRole('button', { name: 'Close plan and return to list' });
        if (await viewerClose.count()) await viewerClose.click();
        await page.getByRole('button', { name: 'Open Plain notes' }).click();
        const disabled = page.getByRole('button', { name: 'Execute', exact: true });
        await expect(disabled).toBeDisabled();
        await expect(
          page.getByText('This Org document is not a valid Gestalt plan.'),
        ).toBeVisible();
        const disabledStyle = await disabled.evaluate((button) => ({
          color: getComputedStyle(button).color,
          background: getComputedStyle(button).backgroundColor,
          opacity: getComputedStyle(button).opacity,
        }));
        expect(disabledStyle.background).not.toBe(enabledStyle.background);
        expect(Number(disabledStyle.opacity)).toBeLessThan(1);
        await noOverflow(page);

        // Scroll the action into its normal interaction position and check fixed navigation clearance.
        await disabled.scrollIntoViewIfNeeded();
        const disabledBox = await target(disabled);
        const disabledView = { ...(await viewportBounds(page)), action: disabledBox };
        await page.screenshot({ path: testInfo.outputPath('disabled.png'), fullPage: false });
        const navigation = await page.getByLabel('Primary').boundingBox();
        if (navigation)
          expect(
            disabledBox.y + disabledBox.height <= navigation.y + 1 ||
              disabledBox.y >= navigation.y + navigation.height - 1 ||
              disabledBox.x >= navigation.x + navigation.width ||
              disabledBox.x + disabledBox.width <= navigation.x,
          ).toBe(true);
        await writeFile(
          testInfo.outputPath('measurements.json'),
          JSON.stringify(
            {
              renderer,
              entry,
              theme,
              configuration,
              headerView,
              actionView,
              dialogTopView,
              dialogControlView,
              sessionView,
              disabledView,
              headerMetrics,
              dialogMetrics,
              modalMetrics,
              sessionMetrics,
              enabledStyle,
              disabledStyle,
              launchRequests: state.launchRequests,
              legitimateLinkedAttachments: state.opens,
              executeAutopilotToggles: state.toggles,
            },
            null,
            2,
          ),
        );
      });
    }
  }
}
