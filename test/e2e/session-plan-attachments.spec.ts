/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, test } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';

for (const width of [320, 1280]) {
  test(`shows restored attachments and direct Copy CLI actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockAuthenticatedStatus(page);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => {
            (window as Window & { copiedCli?: string }).copiedCli = text;
          },
        },
      });
    });
    const plan = {
      title: 'Durable session plan',
      steps: [
        {
          id: 'done',
          title: 'Remember assignment',
          level: 1,
          state: 'DONE',
          priority: 'A',
          description: { effort: 'Small', goal: 'Persist the attachment', notes: 'Done' },
          children: [],
        },
      ],
      currentStepId: null,
      allDone: true,
      doneSteps: 1,
      totalSteps: 1,
    };
    const sessions = [
      {
        id: 'open',
        state: 'ready',
        workspaceId: 'root',
        workspacePath: '/work',
        resumeCommand: 'codex resume open',
        lastOrgPlan: { filename: 'persistent.org', title: plan.title, attached: true },
        plan,
      },
      {
        id: 'saved',
        state: 'released',
        workspaceId: 'root',
        workspacePath: '/work',
        resumeCommand: 'codex resume saved',
        lastOrgPlan: { filename: 'persistent.org', title: plan.title, attached: true },
        plan,
      },
      {
        id: 'closed',
        state: 'released',
        workspaceId: 'root',
        workspacePath: '/work',
        lastOrgPlan: { filename: 'historical.org', title: 'Previous plan', attached: false },
      },
    ];
    await page.route('**/api/bootstrap', (route) =>
      route.fulfill({
        json: {
          workspaces: [
            { id: 'root', name: 'work', relativePath: '.', isGitRepository: false, children: [] },
          ],
          profiles: [],
          sessions,
        },
      }),
    );
    await page.route('**/api/sessions', (route) => route.fulfill({ json: sessions }));
    await page.route('**/api/sessions/recent-threads', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/skill-profiles', (route) => route.fulfill({ json: { profiles: [] } }));
    await page.goto('/');
    await expect(page.getByText('Org plan attached', { exact: true })).toHaveCount(2);
    await expect(
      page.getByLabel('Open sessions').getByRole('button', { name: 'Copy CLI', exact: true }),
    ).toBeVisible();
    const saved = page.getByLabel('Saved sessions');
    await expect(saved.getByText('persistent.org', { exact: true })).toBeVisible();
    await expect(saved.getByLabel('Plan progress for Durable session plan')).toBeVisible();
    await expect(page.getByLabel('Session menu')).toHaveCount(0);
    await saved.getByRole('button', { name: 'Copy CLI', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as Window & { copiedCli?: string }).copiedCli))
      .toBe('codex resume saved');
    await page.reload();
    await expect(page.getByText('Org plan attached', { exact: true })).toHaveCount(2);
    await expect(saved.getByText('persistent.org', { exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({ path: `/tmp/mobile-session-attachments-${width}.png` });
  });
}
