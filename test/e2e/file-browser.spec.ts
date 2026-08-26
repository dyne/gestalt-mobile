/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';

async function openBrowser(page: Page): Promise<void> {
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
          { name: 'nested', path: 'nested', kind: 'directory' },
          { name: 'note.txt', path: 'note.txt', kind: 'file' },
        ],
      }),
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Git' }).click();
  await page.getByRole('treeitem', { name: /repo/ }).click();
  await page.getByRole('button', { name: 'Browse files' }).click();
  await expect(page.getByRole('dialog', { name: 'Files in ~/repo' })).toBeVisible();
}

test('uploads each chosen file sequentially and restores focus after closing', async ({ page }) => {
  const uploads: string[] = [];
  await openBrowser(page);
  await page.route('**/api/workspaces/repo/files/upload?**', async (route) => {
    uploads.push(new URL(route.request().url()).searchParams.get('filename') ?? '');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ path: `nested/${uploads.at(-1)}`, kind: 'file' }),
    });
  });
  await page.getByRole('treeitem', { name: /nested/ }).click();
  await page.getByLabel('Choose files to upload').setInputFiles([
    { name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('one') },
    { name: 'two.txt', mimeType: 'text/plain', buffer: Buffer.from('two') },
  ]);
  await expect.poll(() => uploads).toEqual(['one.txt', 'two.txt']);
  await expect(page.getByLabel('Upload queue')).toContainText('2 completed');
  await page.getByRole('button', { name: 'Close file browser' }).click();
  await expect(page.getByRole('button', { name: 'Browse files' })).toBeFocused();
});

test('requires confirmation before delete and sends a recursive payload', async ({ page }) => {
  await openBrowser(page);
  let deletes = 0;
  await page.route('**/api/workspaces/repo/files', async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    deletes += 1;
    expect(JSON.parse(route.request().postData() ?? '{}')).toEqual({
      path: 'nested',
      recursive: true,
    });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ path: 'nested', kind: 'directory' }),
    });
  });
  await page.getByRole('treeitem', { name: /nested/ }).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByLabel('Delete confirmation')).toBeVisible();
  expect(deletes).toBe(0);
  await page.getByLabel('Delete confirmation').getByRole('button', { name: 'Cancel' }).click();
  expect(deletes).toBe(0);
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByLabel('Delete confirmation').getByRole('button', { name: 'Delete' }).click();
  await expect.poll(() => deletes).toBe(1);
});

test('pauses an upload collision and sends the selected conflict disposition', async ({ page }) => {
  await openBrowser(page);
  const conflicts: string[] = [];
  await page.route('**/api/workspaces/repo/files/upload?**', async (route) => {
    const conflict = new URL(route.request().url()).searchParams.get('conflict') ?? '';
    conflicts.push(conflict);
    await route.fulfill(
      conflict === 'reject'
        ? {
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'FILE_CONFLICT', replaceAllowed: true }),
          }
        : {
            contentType: 'application/json',
            body: JSON.stringify({ path: 'nested/note.txt', kind: 'file' }),
          },
    );
  });
  await page.getByRole('treeitem', { name: /nested/ }).click();
  await page.getByLabel('Choose files to upload').setInputFiles({
    name: 'note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('replacement'),
  });
  await expect(page.getByLabel('Upload conflict')).toBeVisible();
  await page.getByLabel('Upload conflict').getByRole('button', { name: 'Keep both' }).click();
  await expect.poll(() => conflicts).toEqual(['reject', 'keep-both']);
});
