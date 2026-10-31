/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture } from './chat-relay-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

async function openChat(page: Page, activeTurnId: string | null = null): Promise<void> {
  await mockAuthenticatedStatus(page);
  const fixture = new ChatRelayFixture(page);
  await fixture.install([
    {
      id: 's',
      state: activeTurnId ? 'turnActive' : 'ready',
      threadId: 't',
      workspaceId: 'w',
      workspacePath: '/workspace',
      profile: 'default',
      activeTurnId,
      pendingInteractions: [],
    },
  ]);
  fixture.snapshot('s', chatSnapshot({ activeTurnId }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
}

for (const width of [390, 1280]) {
  test(`the empty prompt upload button opens the native file picker at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await openChat(page);
    const uploads: string[] = [];
    await page.route('**/api/workspaces/w/files/upload?**', async (route) => {
      const query = new URL(route.request().url()).searchParams;
      expect(query.get('directory')).toBe('');
      const name = query.get('filename')!;
      uploads.push(name);
      await route.fulfill({ json: { path: name, kind: 'file' } });
    });
    const button = page.getByRole('button', { name: 'Upload files', exact: true });
    await expect(button).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('upload-button.png') });
    const chooserPromise = page.waitForEvent('filechooser');
    await button.click();
    const chooser = await chooserPromise;
    expect(chooser.isMultiple()).toBe(true);
    await chooser.setFiles([
      { name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('one') },
      { name: 'two.txt', mimeType: 'text/plain', buffer: Buffer.from('two') },
    ]);
    await expect.poll(() => uploads).toEqual(['one.txt', 'two.txt']);
    await expect(button).toBeEnabled();
    const repeatChooser = page.waitForEvent('filechooser');
    await button.click();
    await (
      await repeatChooser
    ).setFiles({ name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('one') });
    await expect.poll(() => uploads).toEqual(['one.txt', 'two.txt', 'one.txt']);
    await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('');
  });

  test(`the active-turn menu offers upload with empty and filled prompts at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await openChat(page, 'turn-1');
    let uploads = 0;
    let interrupts = 0;
    await page.route('**/api/workspaces/w/files/upload?**', async (route) => {
      uploads += 1;
      await route.fulfill({ json: { path: 'note.txt', kind: 'file' } });
    });
    await page.route('**/api/sessions/s/turns/turn-1/interrupt', async (route) => {
      interrupts += 1;
      await route.fulfill({ json: { accepted: true } });
    });
    const trigger = page.getByRole('button', { name: 'Choose prompt action' });
    for (const message of ['Keep this draft', '']) {
      await page.getByRole('textbox', { name: 'Prompt' }).fill(message);
      await trigger.click();
      await expect(page.getByRole('button', { name: 'Upload files', exact: true })).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Upload files', exact: true }),
      ).toBeInViewport();
      if (message) {
        await expect(page.getByRole('button', { name: 'Queue message' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Interrupt and send' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Interrupt', exact: true })).toHaveCount(0);
      } else {
        await expect(page.getByRole('button', { name: 'Interrupt', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Queue message' })).toHaveCount(0);
      }
      await page.screenshot({
        path: testInfo.outputPath(message ? 'three-actions.png' : 'two-actions.png'),
      });
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Upload files', exact: true }).click();
      await (
        await chooser
      ).setFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('contents') });
      await expect(trigger).toBeEnabled();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue(message);
    }
    expect(uploads).toBe(2);
    expect(interrupts).toBe(0);
    await page.getByRole('textbox', { name: 'Prompt' }).fill('');
    await trigger.click();
    await page.getByRole('button', { name: 'Interrupt', exact: true }).click();
    await expect.poll(() => interrupts).toBe(1);
  });

  test(`dropping files on the chat input uploads to the session workspace root at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await openChat(page);
    const uploads: string[] = [];
    const keys: string[] = [];
    await page.route('**/api/workspaces/w/files/upload?**', async (route) => {
      const request = route.request();
      const query = new URL(request.url()).searchParams;
      expect(request.method()).toBe('PUT');
      expect(query.get('directory')).toBe('');
      expect(query.get('conflict')).toBe('keep-both');
      expect(request.headers()['content-type']).toBe('application/octet-stream');
      expect(request.postDataBuffer()?.toString()).toBe(query.get('filename'));
      keys.push(request.headers()['idempotency-key']);
      uploads.push(query.get('filename')!);
      await route.fulfill({ json: { path: query.get('filename'), kind: 'file' } });
    });
    const prompt = page.getByRole('textbox', { name: 'Prompt' });
    await prompt.fill('Keep this draft');
    const dataTransfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      for (const name of ['one.txt', 'two.txt']) data.items.add(new File([name], name));
      return data;
    });
    await prompt.dispatchEvent('dragenter', { dataTransfer });
    await expect(page.getByText(/Drop files to upload to workspace root/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('drop-target.png') });
    await prompt.dispatchEvent('drop', { dataTransfer });
    await expect.poll(() => uploads).toEqual(['one.txt', 'two.txt']);
    await expect(page.getByText('Uploaded two.txt to workspace root.')).toBeVisible();
    await expect(prompt).toHaveValue('Keep this draft');
    await expect(page.getByRole('button', { name: 'Send prompt' })).toBeEnabled();
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(2);
    await dataTransfer.dispose();
  });
}

test('oversized files and server failures notify the user while remaining files still upload', async ({
  page,
}) => {
  await openChat(page);
  const uploads: string[] = [];
  await page.route('**/api/workspaces/w/files/upload?**', async (route) => {
    const name = new URL(route.request().url()).searchParams.get('filename')!;
    uploads.push(name);
    await route.fulfill(
      name === 'failed.txt'
        ? { status: 503, json: { code: 'WORKSPACE_FILES_UNAVAILABLE' } }
        : { json: { path: 'ok.txt', kind: 'file' } },
    );
  });
  const dataTransfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    const large = new File([], 'large.bin');
    Object.defineProperty(large, 'size', { value: 100 * 1024 * 1024 + 1 });
    data.items.add(large);
    data.items.add(new File(['failed'], 'failed.txt'));
    data.items.add(new File(['ok'], 'ok.txt'));
    return data;
  });
  await page.getByRole('textbox', { name: 'Prompt' }).dispatchEvent('drop', { dataTransfer });
  await expect(page.getByText('large.bin exceeds the 100 MiB file limit.')).toBeVisible();
  await expect(
    page.getByText('The file could not be uploaded. Try dropping it again.'),
  ).toBeVisible();
  await expect(page.getByText('Uploaded ok.txt to workspace root.')).toBeVisible();
  expect(uploads).toEqual(['failed.txt', 'ok.txt']);
  await dataTransfer.dispose();
});
