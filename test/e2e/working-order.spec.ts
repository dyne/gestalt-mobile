/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { ChatRelayFixture } from './chat-relay-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';
import { mockAuthenticatedStatus } from './auth-fixture.js';

for (const width of [390, 1280]) {
  test(`working paragraphs arrive at the top and preserve older reading position at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockAuthenticatedStatus(page);
    const fixture = new ChatRelayFixture(page);
    await fixture.install([
      {
        id: 's',
        state: 'turnActive',
        threadId: 't',
        workspaceId: 'w',
        workspacePath: '/workspace',
        profile: 'default',
        activeTurnId: 'turn',
        pendingInteractions: [],
      },
    ]);
    const paragraphs = Array.from({ length: 24 }, (_, index) =>
      `Paragraph ${index}. ${'A progress update about the ongoing work. '.repeat(3)}`.trim(),
    );
    fixture.snapshot(
      's',
      chatSnapshot({
        activeTurnId: 'turn',
        items: [
          { id: 'prompt', kind: 'user', text: 'Inspect this workspace', turnId: 'turn' },
          {
            id: 'commentary',
            kind: 'agent',
            phase: 'commentary',
            text: paragraphs.join('\n\n'),
            turnId: 'turn',
          },
        ],
      }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    const working = page.locator('.progress-turn');
    await expect(working.getByText('working', { exact: true })).toBeVisible();
    await expect(working.locator('.working-content .message-content').first()).toHaveText(
      paragraphs[23]!,
    );
    await expect(working.locator('details')).toHaveCount(0);
    await expect.poll(() => fixture.sockets.has('s')).toBe(true);
    fixture.event('s', 1, 'agentMessageDelta', {
      itemId: 'commentary',
      turnId: 'turn',
      phase: 'commentary',
      text: '\n\nNewest streaming paragraph.',
    });
    await expect(working.locator('.working-content .message-content').first()).toHaveText(
      'Newest streaming paragraph.',
    );
    await expect(
      working.getByText('Newest streaming paragraph.', { exact: true }),
    ).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('newest-working-paragraph.png') });
    const older = working.getByText(paragraphs[10]!, { exact: true });
    await older.scrollIntoViewIfNeeded();
    const before = (await older.boundingBox())!.y;
    fixture.event('s', 2, 'agentMessageDelta', {
      itemId: 'commentary-next',
      turnId: 'turn',
      phase: 'commentary',
      text: 'A separate newest status.',
    });
    await expect(working.locator('.working-content .message-content').first()).toHaveText(
      'A separate newest status.',
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(Math.abs((await older.boundingBox())!.y - before)).toBeLessThanOrEqual(2);
  });
}
