/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, test } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';

for (const width of [390, 1280]) {
  test(`plan Notes opens shared previews and file trees at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockAuthenticatedStatus(page);
    const planName = 'repo/.gestalt/plans/roadmap.org';
    const requests: string[] = [];
    await page.route('**/api/bootstrap', (route) =>
      route.fulfill({
        json: {
          workspaces: [
            { id: 'root', name: '/', relativePath: '.', isGitRepository: false, children: [] },
          ],
          profiles: [],
          sessions: [],
        },
      }),
    );
    await page.route('**/api/sessions/recent-threads', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/sessions', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/skill-profiles', (route) => route.fulfill({ json: { profiles: [] } }));
    await page.route('**/api/workspaces/root/plans', (route) =>
      route.fulfill({ json: [{ planName, title: 'Preview roadmap', previewAvailable: false }] }),
    );
    await page.route(`**/api/workspaces/root/plans/${encodeURIComponent(planName)}`, (route) =>
      route.fulfill({
        json: {
          kind: 'org-source',
          planName,
          title: 'Preview roadmap',
          source:
            '#+TITLE: Preview roadmap\n* TODO Read files\n- Notes :: Read =docs/README.md=\n  Then =config.json=\n  Browse =docs=\n  Missing =missing.txt=',
        },
      }),
    );
    await page.route('**/api/workspaces/root/files/preview?**', (route) => {
      const path = new URL(route.request().url()).searchParams.get('path') ?? '';
      requests.push(path);
      if (path === 'repo/missing.txt')
        return route.fulfill({ status: 404, json: { code: 'FILE_PREVIEW_NOT_FOUND' } });
      return route.fulfill({
        json:
          path === 'repo/docs'
            ? { kind: 'directory', path }
            : {
                kind: 'file',
                path,
                size: 70,
                content: path.endsWith('.json')
                  ? '{"count":2,"enabled":true}'
                  : '# Project notes\n\n- First item\n- **Second item**\n\n[Config](../config.json)\n<script>window.previewUnsafe = true</script>',
              },
      });
    });
    await page.route('**/api/workspaces/root/files?**', (route) => {
      const directory = new URL(route.request().url()).searchParams.get('directory') ?? '';
      return route.fulfill({
        json: {
          directory,
          entries:
            directory === 'repo/docs'
              ? [
                  { name: 'nested', path: 'repo/docs/nested', kind: 'directory' },
                  { name: 'README.md', path: 'repo/docs/README.md', kind: 'file' },
                ]
              : [{ name: 'extra.json', path: 'repo/docs/nested/extra.json', kind: 'file' }],
        },
      });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Plan', exact: true }).click();
    await page.getByRole('button', { name: 'Open Preview roadmap' }).click();
    const notes = page.locator('.notes').filter({ hasText: 'Read' });
    await expect(notes).toHaveCSS('white-space', 'pre-wrap');
    await expect(notes).toContainText('Read docs/README.md\nThen config.json');
    await page.getByRole('link', { name: 'docs/README.md', exact: true }).click();
    let viewer = page.getByRole('dialog', { name: 'README.md' });
    await expect(viewer.getByRole('heading', { name: 'Project notes' })).toBeVisible();
    await expect(viewer.getByRole('listitem')).toHaveCount(2);
    expect(
      await page.evaluate(() => (window as Window & { previewUnsafe?: boolean }).previewUnsafe),
    ).toBeUndefined();
    await viewer.getByRole('link', { name: 'Config' }).click();
    viewer = page.getByRole('dialog', { name: 'config.json' });
    await expect(viewer.locator('pre')).toHaveText('{\n  "count": 2,\n  "enabled": true\n}');
    await viewer.getByRole('button', { name: 'Show source' }).click();
    await expect(viewer.locator('pre')).toHaveText('{"count":2,"enabled":true}');
    await viewer.getByRole('button', { name: 'Close file preview' }).click();
    await expect(page.getByRole('link', { name: 'docs/README.md', exact: true })).toBeFocused();
    await page.getByRole('link', { name: 'docs', exact: true }).click();
    viewer = page.getByRole('dialog', { name: 'docs', exact: true });
    await viewer.getByRole('treeitem', { name: /nested/ }).click();
    await expect(viewer.getByRole('treeitem', { name: /extra.json/ })).toBeVisible();
    await viewer.getByRole('treeitem', { name: /extra.json/ }).click();
    viewer = page.getByRole('dialog', { name: 'extra.json' });
    await expect(viewer.locator('pre')).toContainText('"count": 2');
    await viewer.getByRole('button', { name: 'Back', exact: true }).click();
    viewer = page.getByRole('dialog', { name: 'docs', exact: true });
    await expect(viewer.getByRole('treeitem', { name: /README.md/ })).toBeVisible();
    await expect.poll(() => viewer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/mobile-file-preview-${width}.png` });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('link', { name: 'docs', exact: true })).toBeFocused();
    await page.getByRole('link', { name: 'missing.txt' }).click();
    await expect(
      page.getByText('This file or folder no longer exists. Check the path and try again.'),
    ).toBeVisible();
    expect(requests).toContain('repo/docs/README.md');
  });
}
