/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, test } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';

for (const width of [320, 1280]) {
  test(`shows restored attachments and direct Copy CLI actions at ${width}px`, async ({
    page,
  }, testInfo) => {
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
    const savedPlan = { ...plan, title: 'Saved session plan' };
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
        lastOrgPlan: { filename: 'persistent.org', title: savedPlan.title, attached: true },
        plan: savedPlan,
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
    await page.route('**/api/workspaces/root/plans', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/sessions/*/plan', (route) => {
      expect(route.request().method()).toBe('GET');
      return route.fulfill({
        json: route.request().url().endsWith('/saved/plan') ? savedPlan : plan,
      });
    });
    await page.goto('/');
    await expect(page.getByText('Org plan attached', { exact: true })).toHaveCount(2);
    await expect(
      page.getByLabel('Open sessions').getByRole('button', { name: 'Copy CLI', exact: true }),
    ).toBeVisible();
    const saved = page.getByLabel('Saved sessions');
    await expect(saved.getByText('persistent.org', { exact: true })).toBeVisible();
    await expect(saved.getByLabel('Plan progress for Saved session plan')).toBeVisible();
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
    await page.screenshot({ path: testInfo.outputPath(`session-attachments-${width}.png`) });

    const historyReads: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/history'))
        historyReads.push(new URL(request.url()).pathname);
    });
    await saved.getByRole('button', { name: 'Plan for Saved session plan' }).click();
    await expect(
      page.getByRole('heading', { name: 'Saved session plan', exact: true }),
    ).toBeVisible();
    expect(historyReads).not.toContain('/api/sessions/saved/history');
    await page.getByRole('button', { name: 'Close plan and return to list' }).click();
    await expect(page.getByRole('heading', { name: 'ORG Plans' })).toBeVisible();

    if (width === 1280) {
      await page.setViewportSize({ width: 1600, height: 900 });
      await page
        .getByRole('navigation', { name: 'Primary' })
        .getByRole('button', { name: 'Chat', exact: true })
        .click();
      const sidebar = page.getByRole('complementary', { name: 'Chat sessions and usage' });
      await sidebar.getByRole('button', { name: 'Plan for Saved session plan' }).click();
      await expect(
        page.getByRole('heading', { name: 'Saved session plan', exact: true }),
      ).toBeVisible();
      expect(historyReads).not.toContain('/api/sessions/saved/history');

      await page.goto('/?chat-session=open');
      await page.getByRole('button', { name: 'Plan for this session' }).click();
      await expect(
        page.getByRole('heading', { name: 'Durable session plan', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Close plan and return to chat' }).click();
      await expect(page.getByRole('button', { name: 'Plan for this session' })).toBeVisible();
    }
  });
}
