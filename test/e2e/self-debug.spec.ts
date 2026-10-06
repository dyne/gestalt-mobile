/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test, expect } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`Self DEBUG confirmation, independent Chat, and JSON preview at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockAuthenticatedStatus(page);
    const source = {
      id: 'source',
      threadId: 'source-thread',
      state: 'ready',
      workspaceId: 'workspace',
      workspacePath: '/work/source',
      profile: 'default',
      provider: 'codex',
      activeTurnId: null,
    };
    const context = {
      handoffTrace: 'handoff-live',
      control: 'control-live',
      mobileSession: 'source',
      codexThread: 'source-thread',
      capturedAt: '2026-10-06T12:00:00.000Z',
      versions: [
        { id: 'gestalt-mobile', label: 'Mobile', version: '0.44.3' },
        { id: 'codex', label: 'Codex', version: '0.160.0' },
        { id: 'gestalt', label: 'Gestalt', version: '2.13.1' },
      ],
    };
    const debug = {
      ...source,
      id: 'debug',
      threadId: 'debug-thread',
      workspaceId: 'debug-workspace',
      workspacePath: '/home/user/.gestalt/self-debug',
      selfDebug: {
        context,
        tracePath: 'traces/debug.json',
        agent: { name: 'org-plan-executor', model: 'configured-model' },
      },
    };
    let created = false;
    let creates = 0;
    await page.route('**/api/bootstrap', (route) =>
      route.fulfill({
        json: {
          workspaces: [
            {
              id: 'workspace',
              name: 'source',
              relativePath: '.',
              isGitRepository: false,
              children: [],
            },
          ],
          profiles: [],
          sessions: [source],
          componentVersions: context.versions,
        },
      }),
    );
    await page.route('**/api/sessions', (route) =>
      route.fulfill({ json: created ? [source, debug] : [source] }),
    );
    await page.route('**/api/sessions/recent', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/sessions/*/history', (route) =>
      route.fulfill({ json: chatSnapshot() }),
    );
    await page.route('**/api/sessions/*/activity/refresh', (route) =>
      route.fulfill({ status: 204 }),
    );
    await page.route('**/api/sessions/source', (route) => route.fulfill({ json: source }));
    await page.route('**/api/sessions/debug', (route) => route.fulfill({ json: debug }));
    await page.route('**/api/sessions/source/debug', async (route) => {
      if (route.request().method() === 'GET')
        return route.fulfill({ json: { confirmationId: 'confirmed', context } });
      expect(route.request().postDataJSON()).toEqual({ confirmationId: 'confirmed' });
      creates++;
      created = true;
      return route.fulfill({ status: 202, json: debug });
    });
    await page.route('**/api/sessions/debug/debug/trace', (route) =>
      route.fulfill({
        json: { schemaVersion: 1, context, events: [], sourceAgent: { status: 'unavailable' } },
      }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Open configuration' }).click();
    await expect(page.getByRole('button', { name: 'DEBUG', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Open configuration' }).click();
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('button', { name: 'Open configuration' }).click();
    await page.getByRole('button', { name: 'DEBUG', exact: true }).click();
    const confirmation = page.getByRole('dialog', {
      name: 'Confirm spawning a new Gestalt DEBUG session?',
    });
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText('handoff-live');
    await expect(confirmation).toContainText('0.160.0');
    await expect(confirmation.getByRole('button', { name: 'Cancel' })).toBeFocused();
    expect(
      await confirmation.evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: `output/playwright/self-debug-confirmation-${viewport.width}.png`,
    });
    await confirmation.getByRole('button', { name: 'Cancel' }).click();
    expect(creates).toBe(0);
    await page.getByRole('button', { name: 'Open configuration' }).click();
    await page.getByRole('button', { name: 'DEBUG', exact: true }).click();
    await confirmation.getByRole('button', { name: 'Start Self DEBUG' }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Chat', pressed: true })).toBeVisible();
    expect(creates).toBe(1);
    await page.getByRole('button', { name: 'Sessions', exact: true }).click();
    await page.getByText('Self DEBUG', { exact: true }).click();
    await page.getByRole('button', { name: 'Redacted diagnostic trace (JSON)' }).click();
    const preview = page.getByRole('dialog', { name: 'debug.json' });
    await expect(preview.getByLabel('JSON contents')).toBeVisible();
    await preview.getByRole('button', { name: 'Show source' }).click();
    await expect(preview).toContainText('"schemaVersion": 1');
    await expect(preview).toContainText('"sourceAgent"');
    expect(await preview.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `output/playwright/self-debug-trace-${viewport.width}.png` });
    await preview.getByRole('button', { name: 'Close file preview' }).click();
    await expect(
      page.getByRole('button', { name: 'Redacted diagnostic trace (JSON)' }),
    ).toBeFocused();
  });
}
