/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture } from './chat-relay-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

for (const width of [390, 1280]) {
  test(`chat file links open the shared viewer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockAuthenticatedStatus(page);
    const fixture = new ChatRelayFixture(page);
    await fixture.install([
      {
        id: 's',
        state: 'ready',
        threadId: 't',
        workspaceId: 'w',
        workspacePath: '/workspace',
        profile: 'default',
        activeTurnId: null,
        pendingInteractions: [],
      },
    ]);
    fixture.snapshot(
      's',
      chatSnapshot({
        items: [
          {
            id: 'a',
            kind: 'agent',
            text: '[Trace](/tmp/trace.json) [Notes](</workspace/My Notes.md:12>) [Source](/workspace/app.ts#L50) [Missing](/tmp/missing.json) [Web](https://example.com)',
            phase: 'final_answer',
          },
        ],
      }),
    );
    const paths: string[] = [];
    await page.route('**/api/sessions/s/files/preview?**', (route) => {
      const path = new URL(route.request().url()).searchParams.get('path')!;
      paths.push(path);
      if (path.includes('missing'))
        return route.fulfill({ status: 404, json: { code: 'FILE_PREVIEW_NOT_FOUND' } });
      return route.fulfill({
        json: {
          kind: 'file',
          path,
          size: 20,
          content: path.endsWith('.json')
            ? '{"ok":true}'
            : path.endsWith('.md')
              ? '# File notes\n\n**Readable**'
              : Array.from({ length: 100 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n'),
        },
      });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    const url = page.url();
    for (const [label, path] of [
      ['Trace', '/tmp/trace.json'],
      ['Notes', '/workspace/My Notes.md'],
      ['Source', '/workspace/app.ts'],
    ]) {
      const link = page.getByRole('link', { name: label, exact: true });
      await link.focus();
      await page.keyboard.press('Enter');
      const viewer = page.getByRole('dialog');
      await expect(viewer).toBeVisible();
      await expect(viewer).toContainText(path);
      if (label === 'Trace')
        await expect(viewer.getByRole('button', { name: 'Unfold all JSON' })).toBeVisible();
      if (label === 'Notes') {
        await expect(viewer).toContainText('Line 12 unavailable');
        await viewer.getByRole('button', { name: 'Show formatted' }).click();
        await expect(viewer.getByRole('heading', { name: 'File notes' })).toBeVisible();
      }
      if (label === 'Source') {
        const line = viewer.getByLabel('Highlighted line 50');
        await expect(line).toContainText('const line50 = 50;');
        const row = await line.boundingBox();
        const contents = await viewer.locator('.contents').boundingBox();
        expect(row).not.toBeNull();
        expect(contents).not.toBeNull();
        expect(
          Math.abs(row!.y + row!.height / 2 - (contents!.y + contents!.height / 2)),
        ).toBeLessThan(5);
      }
      await viewer.getByRole('button', { name: 'Close file preview' }).click();
      await expect(link).toBeFocused();
      expect(page.url()).toBe(url);
    }
    expect(paths).toEqual(['/tmp/trace.json', '/workspace/My Notes.md', '/workspace/app.ts']);
    await expect(page.getByRole('link', { name: 'Web', exact: true })).toHaveAttribute(
      'target',
      '_blank',
    );
    await page.getByRole('link', { name: 'Missing', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('This item could not be opened.');
    await expect(page.getByRole('alert')).toBeVisible();
  });
}
