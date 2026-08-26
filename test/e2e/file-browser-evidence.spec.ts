/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { expectCleanThemeDiagnostics, openThemeEvidence } from './theme-evidence.js';

async function openBrowser(
  page: Page,
  theme: 'minimal-light' | 'minimal-dark',
  fontScale: 100 | 200,
): Promise<void> {
  await mockAuthenticatedStatus(page);
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: [
          { id: 'repo', name: 'repo', relativePath: 'repo', isGitRepository: true, children: [] },
        ],
        profiles: [],
        sessions: [],
      }),
    }),
  );
  await page.route(/\/api\/git\/repositories\/[^/]+$/, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        available: true,
        branch: 'main',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        dirty: { staged: 0, unstaged: 0, untracked: 0 },
        commits: [],
        fetchedAt: null,
      }),
    }),
  );
  await page.route('**/api/workspaces/repo/files**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        directory: '',
        entries: [
          { name: 'nested-folder', path: 'nested-folder', kind: 'directory' },
          {
            name: 'very-long-file-name-that-must-wrap-safely.txt',
            path: 'very-long-file-name-that-must-wrap-safely.txt',
            kind: 'file',
          },
        ],
      }),
    }),
  );
  const diagnostics = await openThemeEvidence(page, {
    theme,
    fontScale,
    url: '/',
  });
  await page.getByRole('button', { name: 'Git' }).click();
  await page.getByRole('treeitem', { name: /repo/ }).click();
  await page.getByRole('button', { name: 'Browse files' }).click();
  expectCleanThemeDiagnostics(diagnostics);
}

const cases = [
  { viewport: { width: 320, height: 568 }, fontScale: 100 },
  { viewport: { width: 320, height: 568 }, fontScale: 200 },
  { viewport: { width: 1280, height: 800 }, fontScale: 100 },
] as const;
for (const { viewport, fontScale } of cases)
  for (const theme of ['minimal-light', 'minimal-dark'] as const)
    for (const state of [
      'loaded',
      'destination',
      'delete',
      'upload-conflict',
      'upload-error',
    ] as const) {
      test(`captures ${state} ${viewport.width}x${viewport.height}/${fontScale}% ${theme}`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize(viewport);
        await openBrowser(page, theme, fontScale);
        const dialog = page.getByRole('dialog', { name: 'Files in ~/repo' });
        await expect(dialog).toBeVisible();
        if (state === 'destination') {
          await page.getByRole('treeitem', { name: /very-long-file/ }).click();
          await page.getByRole('button', { name: 'Copy' }).click();
        } else if (state === 'delete') {
          await page.getByRole('treeitem', { name: /nested-folder/ }).click();
          await page.getByRole('button', { name: 'Delete' }).click();
        } else if (state === 'upload-conflict') {
          await page.route('**/api/workspaces/repo/files/upload?**', (route) =>
            route.fulfill({
              status: 409,
              contentType: 'application/json',
              body: JSON.stringify({ code: 'FILE_CONFLICT', replaceAllowed: true }),
            }),
          );
          await page.getByRole('treeitem', { name: /nested-folder/ }).click();
          await page.getByLabel('Choose files to upload').setInputFiles({
            name: 'collision.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('collision'),
          });
          await expect(page.getByLabel('Upload conflict')).toBeVisible();
        } else if (state === 'upload-error') {
          await page.getByRole('treeitem', { name: /nested-folder/ }).click();
          await page.getByLabel('Choose files to upload').setInputFiles({
            name: 'large.bin',
            mimeType: 'application/octet-stream',
            buffer: Buffer.alloc(25 * 1024 * 1024 + 1),
          });
        }
        await expect(
          page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        ).resolves.toBe(0);
        await page.screenshot({
          path: testInfo.outputPath(
            `file-browser-${state}-${viewport.width}x${viewport.height}-font${fontScale}-${theme}.png`,
          ),
        });
      });
    }
