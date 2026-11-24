/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture } from './chat-relay-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

for (const width of [390, 1280]) {
  test(`chat file links open the shared viewer at ${width}px`, async ({ page }, testInfo) => {
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
            text: '[Trace](/tmp/trace.json) [Notes](</workspace/My Notes.md:12>) [Source](/workspace/app.ts#L50) [Screenshot](/tmp/screen.png) [Photo](</workspace/My photo.jpg>) [Missing](/tmp/missing.json) [Web](https://example.com)',
            phase: 'final_answer',
          },
        ],
      }),
    );
    const source =
      Array.from({ length: 100 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\r\n') +
      '\r\n// café\r\n';
    const notes = '# File notes\n\n**Readable**';
    const paths: string[] = [];
    const images = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 450;
      return {
        png: canvas.toDataURL('image/png').split(',')[1]!,
        jpeg: canvas.toDataURL('image/jpeg').split(',')[1]!,
      };
    });
    await page.route('**/api/sessions/s/files/preview?**', (route) => {
      const path = new URL(route.request().url()).searchParams.get('path')!;
      paths.push(path);
      if (path.endsWith('.png') || path.endsWith('.jpg')) {
        const format = path.endsWith('.png') ? 'png' : 'jpeg';
        const base64 = images[format];
        return route.fulfill({
          json: {
            kind: 'image',
            path,
            mediaType: `image/${format}`,
            base64,
            size: Buffer.byteLength(base64, 'base64'),
          },
        });
      }
      if (path.includes('missing'))
        return route.fulfill({ status: 404, json: { code: 'FILE_PREVIEW_NOT_FOUND' } });
      const content = path.endsWith('.json')
        ? '{"ok":true}'
        : path.endsWith('.md')
          ? notes
          : source;
      const hasBom = path.endsWith('.ts');
      return route.fulfill({
        json: {
          kind: 'file',
          path,
          content,
          size: Buffer.byteLength(content) + (hasBom ? 3 : 0),
          ...(hasBom ? { hasUtf8Bom: true } : {}),
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
      ['Screenshot', '/tmp/screen.png'],
      ['Photo', '/workspace/My photo.jpg'],
    ]) {
      const link = page.getByRole('link', { name: label, exact: true });
      await link.focus();
      await page.keyboard.press('Enter');
      const viewer = page.getByRole('dialog');
      await expect(viewer).toBeVisible();
      await expect(viewer).toContainText(path);
      if (label === 'Screenshot' || label === 'Photo') {
        const image = viewer.getByRole('img', { name: path.split('/').at(-1)! });
        await expect(image).toBeInViewport();
        await expect
          .poll(() => image.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight]))
          .toEqual([800, 450]);
        expect((await image.boundingBox())!.width).toBeLessThanOrEqual(width);
        await expect(viewer.getByRole('button', { name: 'Show source' })).toHaveCount(0);
      }
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
      if (label === 'Notes' || label === 'Source') {
        const pendingDownload = page.waitForEvent('download');
        await viewer.locator('header').getByRole('button', { name: 'Download file' }).click();
        const download = await pendingDownload;
        const filename = path.split('/').at(-1)!;
        expect(download.suggestedFilename()).toBe(filename);
        const saved = testInfo.outputPath(filename);
        await download.saveAs(saved);
        expect(await readFile(saved)).toEqual(
          Buffer.from(label === 'Notes' ? notes : '\uFEFF' + source),
        );
        await expect(viewer).toBeVisible();
      }
      await viewer.getByRole('button', { name: 'Close file preview' }).click();
      await expect(link).toBeFocused();
      expect(page.url()).toBe(url);
    }
    expect(paths).toEqual([
      '/tmp/trace.json',
      '/workspace/My Notes.md',
      '/workspace/app.ts',
      '/tmp/screen.png',
      '/workspace/My photo.jpg',
    ]);
    await expect(page.getByRole('link', { name: 'Web', exact: true })).toHaveAttribute(
      'target',
      '_blank',
    );
    await page.getByRole('link', { name: 'Missing', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('This item could not be opened.');
    await expect(page.getByRole('alert')).toBeVisible();
  });
}
