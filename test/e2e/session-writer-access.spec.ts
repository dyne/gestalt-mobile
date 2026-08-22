/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, test } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture } from './chat-relay-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

for (const viewport of [
  { name: 'mobile-100', width: 320, height: 568, fontScale: 100 },
  { name: 'tablet-200', width: 768, height: 1024, fontScale: 200 },
]) {
  test(`opens a detached session and retries writer access (${viewport.name})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockAuthenticatedStatus(page);
    const fixture = new ChatRelayFixture(page);
    await fixture.install([
      {
        id: 'saved-session',
        state: 'stopped',
        threadId: 'terminal-owned-thread',
        workspaceId: 'workspace-1',
        workspacePath: '/workspace',
        profile: 'default',
        activeTurnId: null,
      },
    ]);
    fixture.snapshot(
      'saved-session',
      chatSnapshot({
        items: [
          {
            id: 'canonical-prompt',
            kind: 'user',
            text: 'readable canonical history',
            occurredAt: Date.parse('2026-08-13T08:00:00.000Z'),
          },
        ],
      }),
    );
    fixture.lockWriter('saved-session');
    let restoreRequests = 0;
    await page.route('**/api/sessions/saved-session/restore', async (route) => {
      restoreRequests += 1;
      await route.fulfill({ status: 500 });
    });

    await page.goto('/');
    await page.locator('html').evaluate((element, fontScale) => {
      element.style.fontSize = `${fontScale}%`;
    }, viewport.fontScale);
    await page.getByRole('button', { name: 'Sessions' }).click();
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Chat', pressed: true })).toBeVisible();
    await expect(page.getByText('readable canonical history')).toBeVisible();
    await expect(page.getByText('Sending will connect to Codex.')).toBeVisible();
    expect(restoreRequests).toBe(0);
    expect(fixture.protocol.filter((call) => call.kind === 'history')).not.toHaveLength(0);
    expect(fixture.protocol.filter((call) => call.kind === 'resume')).toHaveLength(0);
    expect(fixture.protocol.filter((call) => call.kind === 'turn')).toHaveLength(0);

    const historiesBeforeReconnect = fixture.protocol.filter(
      (call) => call.kind === 'history',
    ).length;
    fixture.close('saved-session');
    await expect
      .poll(() => fixture.protocol.filter((call) => call.kind === 'history').length)
      .toBeGreaterThan(historiesBeforeReconnect);
    await page.reload();
    await page.getByRole('button', { name: 'Chat' }).click();
    await expect(page.getByText('readable canonical history')).toBeVisible();
    await expect(page.getByText('Sending will connect to Codex.')).toBeVisible();

    const prompt = page.getByRole('textbox', { name: 'Prompt' });
    await prompt.fill('acquire once');
    await page.getByRole('button', { name: 'Send prompt' }).click();
    await expect(page.getByRole('region', { name: 'Chat' }).getByRole('alert')).toContainText(
      'active in another Codex client',
    );
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.commands[0]?.idempotencyKey).toBeTruthy();

    fixture.releaseWriter('saved-session');
    const turn = fixture.deferTurn('saved-session');
    await page.getByRole('button', { name: 'Retry send' }).click();
    turn.resolve({ kind: 'fulfill', status: 200, body: { activeTurnId: 'turn-1' } });
    await expect(page.getByRole('button', { name: 'Interrupt' })).toBeVisible();
    expect(fixture.commands).toHaveLength(2);
    expect(fixture.commands[1]?.idempotencyKey).toBe(fixture.commands[0]?.idempotencyKey);
    expect(restoreRequests).toBe(0);
    expect(fixture.protocol.filter((call) => call.kind === 'resume')).toHaveLength(1);
    expect(fixture.protocol.filter((call) => call.kind === 'turn')).toHaveLength(1);
    await page.screenshot({
      path: `output/playwright/session-writer-access-${viewport.name}.png`,
      fullPage: true,
    });
  });

  test(`opens a recent terminal-owned thread without acquiring its writer (${viewport.name})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockAuthenticatedStatus(page);
    const fixture = new ChatRelayFixture(page);
    await fixture.install([]);
    fixture.addRecent(
      {
        id: 'recent-terminal-thread',
        cwd: '/workspace',
        recencyAt: Date.parse('2026-08-13T08:00:00.000Z'),
        resumeCommand: 'codex resume recent-terminal-thread',
      },
      {
        id: 'recent-session',
        state: 'stopped',
        threadId: 'recent-terminal-thread',
        workspaceId: 'workspace-1',
        workspacePath: '/workspace',
        profile: 'default',
        activeTurnId: null,
      },
    );
    fixture.snapshot(
      'recent-session',
      chatSnapshot({
        items: [{ id: 'recent-history', kind: 'user', text: 'recent canonical history' }],
      }),
    );
    fixture.lockWriter('recent-session');
    let restoreRequests = 0;
    await page.route('**/api/sessions/recent-session/restore', async (route) => {
      restoreRequests += 1;
      await route.fulfill({ status: 500 });
    });

    await page.goto('/');
    await page.locator('html').evaluate((element, fontScale) => {
      element.style.fontSize = `${fontScale}%`;
    }, viewport.fontScale);
    await page.getByRole('button', { name: 'Sessions' }).click();
    await page.getByLabel('Recent sessions').getByRole('button', { name: 'Open' }).click();
    await expect(page.getByText('recent canonical history')).toBeVisible();
    expect(fixture.protocol.map((call) => call.kind)).toContain('recentOpen');
    expect(fixture.protocol.filter((call) => call.kind === 'resume')).toHaveLength(0);
    expect(restoreRequests).toBe(0);

    await page.getByRole('textbox', { name: 'Prompt' }).fill('recent acquire');
    await page.getByRole('button', { name: 'Send prompt' }).click();
    await expect(page.getByRole('region', { name: 'Chat' }).getByRole('alert')).toContainText(
      'active in another Codex client',
    );
    const firstKey = fixture.commands[0]?.idempotencyKey;
    fixture.releaseWriter('recent-session');
    const turn = fixture.deferTurn('recent-session');
    await page.getByRole('button', { name: 'Retry send' }).click();
    turn.resolve({ kind: 'fulfill', status: 200, body: { activeTurnId: 'recent-turn' } });
    await expect(page.getByRole('button', { name: 'Interrupt' })).toBeVisible();
    expect(fixture.commands).toHaveLength(2);
    expect(fixture.commands[1]?.idempotencyKey).toBe(firstKey);
    expect(fixture.protocol.filter((call) => call.kind === 'resume')).toHaveLength(1);
    expect(fixture.protocol.filter((call) => call.kind === 'turn')).toHaveLength(1);
    expect(restoreRequests).toBe(0);
  });

  test(`relay restart renders a stale writer as readable detached (${viewport.name})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockAuthenticatedStatus(page);
    const fixture = new ChatRelayFixture(page);
    await fixture.install([
      {
        id: 'stale-runtime-session',
        state: 'ready',
        threadId: 'stale-runtime-thread',
        workspaceId: 'workspace-1',
        workspacePath: '/workspace',
        profile: 'default',
        activeTurnId: null,
      },
    ]);
    fixture.snapshot(
      'stale-runtime-session',
      chatSnapshot({
        items: [{ id: 'stale-history', kind: 'user', text: 'history after relay restart' }],
      }),
    );
    await page.goto('/');
    fixture.sessions[0] = { ...fixture.sessions[0], state: 'stopped' };
    await page.reload();
    await page.getByRole('button', { name: 'Sessions' }).click();
    await expect(page.getByLabel('Open sessions')).toHaveCount(0);
    await expect(
      page.getByLabel('Saved sessions').getByRole('button', { name: 'Open' }),
    ).toBeVisible();
    await page.getByLabel('Saved sessions').getByRole('button', { name: 'Open' }).click();
    await expect(page.getByText('history after relay restart')).toBeVisible();
    await expect(page.getByText('Sending will connect to Codex.')).toBeVisible();
    expect(fixture.protocol.filter((call) => call.kind === 'resume')).toHaveLength(0);
  });
}
