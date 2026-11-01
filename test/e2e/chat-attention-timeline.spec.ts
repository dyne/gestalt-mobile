/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test, expect } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture } from './chat-relay-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';
import { screenshotPath } from './screenshot-path.js';

for (const width of [390, 1280]) {
  test(`quiz stays above chat, shares file rendering and enters resolution history at ${width}px`, async ({
    page,
  }) => {
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
    const requestedAt = '2026-10-24T08:00:00Z';
    const resolvedAt = '2026-10-24T09:00:00Z';
    const question = '**Choose** [Source](/workspace/app.ts:2)';
    const pending = {
      requestId: 'q',
      kind: 'quiz',
      turnId: 't',
      requestedAt,
      resolvedAt: null,
      payload: {
        questions: [
          {
            id: 'choice',
            header: 'Choice',
            question,
            allowCustom: true,
            choices: [
              { label: 'Yes', description: 'Read [Notes](/workspace/notes.md)' },
              { label: 'No', description: 'Keep current behavior' },
            ],
          },
        ],
      },
    };
    const items = [
      {
        id: 'echo',
        kind: 'agent',
        turnId: 't',
        phase: 'final_answer',
        text: question,
        occurredAt: Date.parse(requestedAt),
      },
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `message-${i}`,
        kind: 'user',
        text: `Later message ${i}`,
        occurredAt: Date.parse(requestedAt) + (i + 1) * 1000,
      })),
      {
        id: 'newer',
        kind: 'agent',
        phase: 'final_answer',
        text: 'After resolution',
        occurredAt: Date.parse(resolvedAt) + 1000,
      },
    ];
    fixture.snapshot('s', chatSnapshot({ items, interactions: [pending] }));
    await page.route('**/api/sessions/s/files/preview?**', (route) =>
      route.fulfill({
        json: {
          kind: 'file',
          path: '/workspace/app.ts',
          size: 30,
          content: 'const one = 1;\nconst two = 2;',
        },
      }),
    );
    const response = fixture.deferInteraction('q');
    fixture
      .deferTurn('s')
      .resolve({ kind: 'fulfill', status: 202, body: { activeTurnId: 'answer-turn' } });
    await page.goto('/');
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Pending chat requests' });
    await expect(panel).toBeVisible();
    await expect(page.getByRole('link', { name: 'Source', exact: true })).toHaveCount(1);
    await expect(panel.locator('strong').filter({ hasText: 'Choose' })).toHaveCount(1);
    await page.evaluate(() => window.scrollBy(0, 500));
    await expect(panel).toBeInViewport();
    await panel.getByRole('link', { name: 'Source', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('Highlighted line 2')).toBeVisible();
    await page.getByRole('button', { name: 'Close file preview' }).click();
    await panel.getByRole('radio', { name: 'Yes', exact: true }).check();
    await page.screenshot({ path: screenshotPath(`chat-attention-pending-${width}.png`) });
    await panel.getByRole('button', { name: 'Send answers' }).click();
    await expect(panel.getByText('Submitting…')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Source', exact: true })).toHaveCount(1);
    fixture.event(
      's',
      1,
      'interaction.resolved',
      { requestId: 'q', outcome: 'answered' },
      resolvedAt,
    );
    response.resolve({
      kind: 'fulfill',
      status: 202,
      body: { accepted: true, outcome: 'answered' },
    });
    await expect(panel).toHaveCount(0);
    const history = page.getByRole('list', { name: 'Chat messages' });
    await expect(history.locator(':scope > li').nth(0)).toContainText('After resolution');
    await expect(history.locator(':scope > li').nth(1)).toContainText('Answers sent');
    await expect(history.locator(':scope > li').nth(2)).toContainText('Later message 19');
    await expect
      .poll(() => fixture.commands.filter((command) => command.kind === 'turn').length)
      .toBe(1);
    const followup = fixture.commands.find((command) => command.kind === 'turn')!;
    const followupText = (followup.body as { text: string }).text;
    fixture.snapshot(
      's',
      chatSnapshot({
        baseSequence: 1,
        // The accepted quiz follow-up is durable server history, including its operation key.
        items: [
          ...items,
          {
            id: 'quiz-answer-prompt',
            kind: 'user',
            turnId: 'answer-turn',
            operationId: followup.idempotencyKey ?? undefined,
            text: followupText,
            occurredAt: Date.parse(resolvedAt),
          },
        ],
        interactions: [
          {
            requestId: 'q',
            kind: 'quiz',
            turnId: 't',
            requestedAt,
            resolvedAt,
            outcome: 'answered',
          },
        ],
      }),
    );
    await page.reload();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(panel).toHaveCount(0);
    const entries = history.locator(':scope > li');
    await expect(entries.filter({ hasText: 'Answers sent' })).toHaveCount(1);
    await expect(history.locator('[data-interaction-state="resolved"]')).toHaveCount(1);
    await expect(entries.filter({ hasText: 'Submitted quiz answers:' })).toHaveCount(1);
    await expect(entries.filter({ hasText: 'Submitted quiz answers:' })).toContainText('Yes');
    await expect
      .poll(async () => {
        const labels = await entries.allTextContents();
        const after = labels.findIndex((label) => label.includes('After resolution'));
        const answer = labels.findIndex((label) => label.includes('Answers sent'));
        const later = labels.findIndex((label) => label.includes('Later message 19'));
        return after >= 0 && after < answer && answer < later;
      })
      .toBe(true);
    await expect(entries.filter({ hasText: 'After resolution' })).toHaveCount(1);
    await expect(entries.filter({ hasText: 'Later message 19' })).toHaveCount(1);
    const labels = await entries.allTextContents();
    expect(new Set(labels).size).toBe(labels.length);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: screenshotPath(`chat-attention-resolved-${width}.png`) });
  });
}
