/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';

for (const [code, guidance] of [
  ['CODEX_EXECUTOR_MODEL_UNAVAILABLE', 'Choose an available executor model'],
  ['CODEX_MODEL_UNAVAILABLE', 'Choose an available model'],
  ['SESSION_WORKSPACE_UNAVAILABLE', 'temporary ownership could not be confirmed'],
  ['SESSION_WORKSPACE_LOCKED', 'close it to release the reservation'],
]) {
  test(`explains ${code} in the session creation error toast`, async ({ page }) => {
    await mockAuthenticatedStatus(page);
    await page.route('**/api/bootstrap', (route) =>
      route.fulfill({
        json: {
          workspaces: [
            { id: 'w', name: 'project', relativePath: '.', isGitRepository: false, children: [] },
          ],
          profiles: [],
          sessions: [],
          models: { codex: ['gpt-6.1-sol'], kimi: [] },
        },
      }),
    );
    await page.route('**/api/skill-profiles', (route) => route.fulfill({ json: { profiles: [] } }));
    await page.route('**/api/sessions/recent-threads', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/sessions', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 503, json: { code, detail: 'private runtime detail' } })
        : route.fulfill({ json: [] }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Create session' }).click();
    await expect(page.getByRole('alert')).toContainText(guidance);
    await expect(page.getByRole('alert')).not.toContainText('private runtime detail');
    await expect(page.getByRole('button', { name: 'Create session' })).toBeEnabled();
  });
}
