/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

test.beforeEach(async ({ page }) => mockAuthenticatedStatus(page));

type PendingInteraction = { requestId: string; kind: string; payload: unknown };

function session(pendingInteractions: PendingInteraction[]) {
  return {
    id: 'session-1',
    state: 'ready',
    threadId: 'thread-1',
    workspaceId: 'workspace-1',
    workspacePath: '/workspace',
    profile: 'default',
    activeTurnId: 'turn-1',
    pendingInteractions,
  };
}

async function openChat(page: Page, pendingInteractions: PendingInteraction[]): Promise<void> {
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: [],
        profiles: [],
        sessions: [session(pendingInteractions)],
      }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        chatSnapshot({
          activeTurnId: 'turn-1',
          interactions: pendingInteractions.map((interaction) => ({
            requestId: interaction.requestId,
            kind: interaction.kind,
            payload: interaction.payload,
            turnId: 'turn-1',
            requestedAt: '2026-01-01T00:00:00.000Z',
            resolvedAt: null,
          })),
        }),
      ),
    }),
  );
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.routeWebSocket(
    /ws:\/\/127\.0\.0\.1:4173\/api\/sessions\/session-1\/events\?after=\d+/,
    () => {},
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat' }).click();
}

test('shows file targets and separately tappable approval controls at a compact viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openChat(page, [
    {
      requestId: 'file-1',
      kind: 'fileChangeApproval',
      payload: { changes: [{ path: 'src/client/App.svelte' }, { path: 'src/server/app.ts' }] },
    },
  ]);

  await expect(page.getByRole('list', { name: 'Files to change' })).toContainText(
    'src/client/App.svelte',
  );
  await expect(page.getByRole('list', { name: 'Files to change' })).toContainText(
    'src/server/app.ts',
  );
  const approve = page.getByRole('button', { name: 'Approve' });
  const deny = page.getByRole('button', { name: 'Deny' });
  await expect(approve).toBeVisible();
  await expect(deny).toBeVisible();
  expect(await approve.boundingBox()).not.toEqual(await deny.boundingBox());
});

test('retries a failed quiz once and suppresses a duplicate accepted request', async ({ page }) => {
  await openChat(page, [
    {
      requestId: 'quiz-1',
      kind: 'quiz',
      payload: {
        questions: [
          {
            id: 'execution_mode',
            header: 'Execution mode',
            question: 'How should this plan run?',
            choices: [
              { label: 'Solo', description: 'One agent executes the plan.' },
              { label: 'Supervised multi-agent', description: 'A supervisor coordinates agents.' },
            ],
            allowCustom: false,
            isSecret: false,
          },
        ],
      },
    },
  ]);
  let attempts = 0;
  await page.route('**/api/sessions/session-1/interactions/quiz-1', async (route) => {
    attempts += 1;
    expect(route.request().postDataJSON()).toEqual({
      success: true,
      contentItems: [{ type: 'input_text', text: '{"answers":{"execution_mode":"Solo"}}' }],
    });
    await route.fulfill({
      status: attempts === 1 ? 409 : 202,
      contentType: 'application/json',
      body: JSON.stringify(attempts === 1 ? { title: 'Relay unavailable' } : { accepted: true }),
    });
  });

  await page.getByRole('radio', { name: /Solo/ }).click();
  await page.getByRole('button', { name: 'Send answers' }).click();
  await expect(page.getByRole('button', { name: 'Send answers' })).toBeVisible();

  await page.getByRole('button', { name: 'Send answers' }).click();
  await expect(page.getByRole('button', { name: 'Send answers' })).toBeVisible();
  expect(attempts).toBe(2);

  await page.getByRole('button', { name: 'Send answers' }).click();
  await page.waitForTimeout(100);
  expect(attempts).toBe(2);
});
