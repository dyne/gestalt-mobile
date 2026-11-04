/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture } from './chat-relay-fixture.js';
import { openThemeEvidence } from './theme-evidence.js';

// Keep baseline screenshots separate from the later busy/failure evidence.
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  for (const fontScale of [100, 200] as const) {
    test(`session forgetting incumbent baseline ${viewport.width}x${viewport.height} font${fontScale}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await mockAuthenticatedStatus(page);
      const fixture = new ChatRelayFixture(page);
      await fixture.install([
        {
          id: 'baseline-open',
          state: 'ready',
          threadId: 'baseline-open-thread',
          workspaceId: 'workspace-1',
          workspacePath: '/workspace/another-session-remains-usable',
          model: 'gpt-5.6-terra',
          resumeCommand: 'codex resume baseline-open-thread',
        },
        {
          id: 'baseline-saved',
          state: 'stopped',
          threadId: 'baseline-saved-thread',
          workspaceId: 'workspace-1',
          workspacePath:
            '/workspace/a-session-with-an-extraordinarily-long-workspace-and-repository-name',
          model: 'gpt-5.6-terra',
          resumeCommand: 'codex resume baseline-saved-thread',
          lastOrgPlan: {
            filename: 'a-long-session-plan.org',
            title: 'A long session title that stays readable while its temporary files are removed',
            attached: false,
          },
        },
      ]);
      await openThemeEvidence(page, { theme: 'dyne-org', fontScale, url: '/' });
      await page.getByRole('button', { name: 'Sessions', exact: true }).click();
      const saved = page.getByRole('list', { name: 'Saved sessions' });
      await expect(saved.getByRole('button', { name: 'Forget', exact: true })).toBeVisible();
      await saved.getByRole('button', { name: 'Forget', exact: true }).focus();
      await expect(saved.getByRole('button', { name: 'Forget', exact: true })).toBeFocused();
      await page.screenshot({
        path: testInfo.outputPath('sessions-incumbent.png'),
        fullPage: true,
      });

      await page.getByRole('button', { name: 'Chat', exact: true }).click();
      const sidebar = page.getByRole('complementary', { name: 'Chat sessions and usage' });
      // Preserve the existing responsive rule: the sidebar needs 88rem.
      if (viewport.width >= 88 * 16 * (fontScale / 100)) {
        await expect(sidebar).toBeVisible();
        await sidebar.getByRole('button', { name: 'Forget', exact: true }).focus();
        await expect(sidebar.getByRole('button', { name: 'Forget', exact: true })).toBeFocused();
      } else {
        await expect(sidebar).toHaveCount(0);
      }
      await page.screenshot({ path: testInfo.outputPath('chat-incumbent.png'), fullPage: true });
    });
  }
}
