/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { CleanTmpResult } from '../../src/shared/contracts/tmp-cleanup.js';
import type { SupervisedPlan } from '../../src/client/features/plans/contracts.js';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture, deferred } from './chat-relay-fixture.js';
import { captureMenuTarget } from './menu-evidence.js';
import { expectCleanThemeDiagnostics, openThemeEvidence } from './theme-evidence.js';

test.use({ hasTouch: true });

const empty: CleanTmpResult = {
  status: 'complete',
  folders: { removed: 0, skipped: 0, failed: 0 },
  workspaces: { cleaned: 2, removed: 0, skipped: 0, failed: 0, unavailable: 0 },
  reasons: { protected: 0, busy: 0, lease: 0, unrecognized: 0, unsafe: 0, unavailable: 0, io: 0 },
};
const complete: CleanTmpResult = {
  ...empty,
  folders: { removed: 2, skipped: 3, failed: 0 },
  workspaces: { cleaned: 0, removed: 2, skipped: 2, failed: 0, unavailable: 0 },
  reasons: { ...empty.reasons, protected: 2, unrecognized: 1 },
};
const partial: CleanTmpResult = {
  ...complete,
  status: 'partial',
  folders: { removed: 1, skipped: 1, failed: 1 },
  workspaces: { cleaned: 0, removed: 1, skipped: 1, failed: 1, unavailable: 1 },
  reasons: { ...empty.reasons, protected: 1, io: 1, unavailable: 1 },
};

async function keyboardAction(page: Page, menu: Locator, label: string) {
  const trigger = page.getByRole('button', { name: 'Open configuration', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  const action = menu.getByRole('button', { name: label, exact: true });
  for (
    let index = 0;
    index < 24 && !(await action.evaluate((el) => el === document.activeElement));
    index++
  )
    await page.keyboard.press('Tab');
  return action;
}

async function captureOutcome(page: Page, toast: Locator, testInfo: TestInfo, name: string) {
  await toast.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  // The incumbent shared toast scrolls at enlarged handset text. Record every
  // segment in reading order rather than hiding chrome or shrinking the copy.
  const bounds = await toast.evaluate((element) => ({
    height: element.clientHeight,
    total: element.scrollHeight,
  }));
  const step = Math.max(1, bounds.height - 12);
  const segments = Math.max(1, Math.ceil((bounds.total - bounds.height) / step) + 1);
  const metrics = [];
  for (let index = 0; index < Math.min(segments, 12); index++) {
    await toast.evaluate((element, offset) => {
      element.scrollTop = offset;
    }, index * step);
    const record = await toast.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        rect: box.toJSON(),
        contentFits: element.scrollWidth <= element.clientWidth + 0.5,
        hit: !!hit && element.contains(hit),
      };
    });
    metrics.push(record);
    await page.screenshot({ path: testInfo.outputPath(`${name}-${index + 1}.png`) });
  }
  await testInfo.attach(`${name}-geometry`, {
    body: JSON.stringify({ segments, metrics }),
    contentType: 'application/json',
  });
  expect(segments).toBeLessThanOrEqual(12);
  for (const metric of metrics) {
    expect(metric.rect.left).toBeGreaterThanOrEqual(-0.5);
    expect(metric.rect.right).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 0.5);
    expect(metric.rect.top).toBeGreaterThanOrEqual(-0.5);
    expect(metric.rect.bottom).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) + 0.5);
    expect(metric.contentFits).toBe(true);
    expect(metric.hit).toBe(true);
  }
  const last = metrics.at(-1)!;
  expect(last.scrollTop + last.clientHeight).toBeGreaterThanOrEqual(last.scrollHeight - 0.5);
  await toast.evaluate((element) => {
    element.scrollTop = 0;
  });
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  for (const fontScale of [100, 200] as const) {
    test(`Clean TMP menu workflow ${viewport.width}x${viewport.height} font${fontScale}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await mockAuthenticatedStatus(page);
      const fixture = new ChatRelayFixture(page);
      await fixture.install([
        {
          id: 'clean-a',
          state: 'ready',
          workspacePath: '/workspace/first',
          model: 'gpt-6.1-sol',
          threadId: 'thread-a',
        },
        {
          id: 'clean-b',
          state: 'ready',
          workspacePath: '/workspace/second',
          model: 'gpt-6.1-sol',
          threadId: 'thread-b',
        },
      ]);
      await page.route('**/api/skill-profiles', (route) =>
        route.fulfill({ json: { profiles: [] } }),
      );
      await page.route('**/api/session-models/*', (route) =>
        route.fulfill({ json: { models: ['gpt-6.1-sol'] } }),
      );
      await page.route('**/api/sessions/clean-*', (route) =>
        route.fulfill({
          json: fixture.sessions.find(
            (session) => session.id === new URL(route.request().url()).pathname.split('/').at(-1),
          ),
        }),
      );
      const plan: SupervisedPlan = {
        title: 'Workspace work',
        steps: [],
        totalSteps: 0,
        doneSteps: 0,
        allDone: true,
        currentStepId: '',
      };
      await page.route('**/api/sessions/*/plan', (route) => route.fulfill({ json: plan }));
      await page.route('**/api/sessions/*/retrieval-readiness', (route) =>
        route.fulfill({ json: { connections: [], repositories: [] } }),
      );
      const requests: Array<ReturnType<typeof deferred<{ status: number; body: unknown }>>> = [];
      const settled: Promise<void>[] = [];
      await page.route('**/api/maintenance/clean-tmp', async (route) => {
        expect(route.request().method()).toBe('POST');
        expect(route.request().postDataJSON()).toEqual({});
        const result = deferred<{ status: number; body: unknown }>();
        const done = deferred<void>();
        requests.push(result);
        settled.push(done.promise);
        try {
          const response = await result.promise;
          await route.fulfill({ status: response.status, json: response.body });
        } finally {
          done.resolve();
        }
      });
      const responses: Array<{ url: string; method: string; status: number }> = [];
      page.on('response', (response) => {
        if (response.status() >= 400)
          responses.push({
            url: response.url(),
            method: response.request().method(),
            status: response.status(),
          });
      });
      const diagnostics = await openThemeEvidence(page, { theme: 'dyne-org', fontScale, url: '/' });
      try {
        await page
          .locator('html')
          .evaluate(
            (element, scale) => element.style.setProperty('font-size', `${scale}%`, 'important'),
            fontScale,
          );
        await expect
          .poll(() => page.locator('html').evaluate((el) => getComputedStyle(el).fontSize))
          .toBe(`${(16 * fontScale) / 100}px`);
        expect(
          await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
        ).toBe(true);
        const menu = page.locator('#configuration-panel');
        const action = await keyboardAction(page, menu, 'Clean TMP');
        await captureMenuTarget(page, action, testInfo, 'clean-ready-keyboard', {
          control: true,
          focused: true,
        });
        await page.keyboard.press('Space');
        await expect.poll(() => requests.length).toBe(1);
        await expect(action).toBeDisabled();
        await expect(action).toHaveAttribute('aria-busy', 'true');
        const status = menu.getByRole('status');
        await status.evaluate((element) => element.scrollIntoView({ block: 'center' }));
        await captureMenuTarget(page, status, testInfo, 'clean-pending');
        await expect(status).toHaveText('Cleaning temporary files…');
        await action.click({ force: true });
        expect(requests).toHaveLength(1);
        await expect(menu.getByRole('button', { name: 'Upgrade', exact: true })).toBeDisabled();
        await expect(menu.getByRole('button', { name: 'Quit', exact: true })).toBeDisabled();
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Sessions', exact: true }).click();
        await page
          .locator('[data-session-id="clean-b"]')
          .getByRole('button', { name: 'Open', exact: true })
          .click();
        const prompt = page.getByRole('textbox', { name: 'Prompt' });
        await expect(prompt).toBeEnabled();
        await prompt.fill('Other workspace remains usable while cleaning');
        await expect(page.getByRole('button', { name: 'Send prompt' })).toBeEnabled();
        requests[0]!.resolve({ status: 200, body: complete });
        const toast = page.locator('.toast');
        await expect(toast).toHaveCount(1);
        await toast.hover(); // Use the queue's existing pause behavior during evidence capture.
        await captureOutcome(page, toast, testInfo, 'clean-complete');
        await expect(toast).toContainText(
          'Removed 2 temporary folders in 2 workspaces. Kept 2 protected folders. Skipped 1 other folder.',
        );
        await expect(toast).toHaveAttribute('role', 'status');
        await page.getByRole('button', { name: 'Dismiss success notification' }).click();
        await expect(prompt).toHaveValue('Other workspace remains usable while cleaning');

        const outcomes = [
          {
            name: 'empty',
            status: 200,
            body: empty,
            kind: 'success',
            text: 'No temporary folders to remove.',
          },
          {
            name: 'partial',
            status: 200,
            body: partial,
            kind: 'error',
            text: 'Cleanup incomplete. Removed 1 temporary folder in 1 workspace. Kept 1 protected folder. Could not remove 1 folder. Could not check 1 workspace. Try Clean TMP again.',
          },
          {
            name: 'request-error',
            status: 503,
            body: { code: 'TMP_CLEANUP_UNAVAILABLE', detail: 'private server path' },
            kind: 'error',
            text: 'Temporary files could not be checked. Try Clean TMP again.',
          },
          {
            name: 'retry',
            status: 200,
            body: empty,
            kind: 'success',
            text: 'No temporary folders to remove.',
          },
        ];
        for (const outcome of outcomes) {
          const retry = await keyboardAction(page, menu, 'Clean TMP');
          await expect(retry).toBeEnabled();
          if (viewport.width === 390) await retry.tap();
          else await page.keyboard.press('Enter');
          const expected = outcomes.indexOf(outcome) + 2;
          await expect.poll(() => requests.length).toBe(expected);
          requests.at(-1)!.resolve({ status: outcome.status, body: outcome.body });
          await expect(menu).not.toBeVisible();
          await expect(
            page.getByRole('button', { name: 'Open configuration', exact: true }),
          ).toBeFocused();
          await expect(toast).toHaveCount(1);
          await toast.hover();
          await captureOutcome(page, toast, testInfo, `clean-${outcome.name}`);
          await expect(toast).toHaveAttribute(
            'role',
            outcome.kind === 'error' ? 'alert' : 'status',
          );
          await expect(toast).toContainText(outcome.text);
          await expect(toast).not.toContainText('private server path');
          await page.getByRole('button', { name: `Dismiss ${outcome.kind} notification` }).click();
        }
        expect(responses).toEqual([
          {
            url: new URL('/api/maintenance/clean-tmp', page.url()).href,
            method: 'POST',
            status: 503,
          },
        ]);
        const expectedError =
          'Failed to load resource: the server responded with a status of 503 (Service Unavailable)';
        expect(
          diagnostics.consoleErrors.filter((value) => value === expectedError).length,
        ).toBeLessThanOrEqual(1);
        expectCleanThemeDiagnostics(diagnostics, { expectedConsoleErrors: [expectedError] });
      } finally {
        requests.forEach((pending) =>
          pending.resolve({ status: 503, body: { code: 'TMP_CLEANUP_UNAVAILABLE' } }),
        );
        await Promise.allSettled(settled);
        await testInfo.attach('clean-menu-diagnostics', {
          body: JSON.stringify({ diagnostics, responses, requests: requests.length }),
          contentType: 'application/json',
        });
      }
    });
  }
}
