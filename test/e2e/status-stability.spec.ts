/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, test, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture } from './chat-relay-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

async function recordStatus(page: Page): Promise<void> {
  await page.getByRole('status').evaluate((element) => {
    const samples = [element.textContent ?? ''];
    const observer = new MutationObserver(() => samples.push(element.textContent ?? ''));
    observer.observe(element, { childList: true, characterData: true, subtree: true });
    Object.assign(window, { statusSamples: samples });
  });
}

for (const activeTurnId of [null, 'turn-1']) {
  test(`history refresh retains the status with active turn ${activeTurnId}`, async ({ page }) => {
    await mockAuthenticatedStatus(page);
    const fixture = new ChatRelayFixture(page);
    await fixture.install([
      {
        id: 'session-1',
        state: activeTurnId ? 'turnActive' : 'ready',
        threadId: 'thread-1',
        workspaceId: 'workspace-1',
        workspacePath: '/workspace',
        profile: 'default',
        activeTurnId,
        pendingInteractions: [],
      },
    ]);
    const snapshot = chatSnapshot({ activeTurnId });
    fixture.snapshot('session-1', snapshot);
    await page.goto('/');
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    const status = page.getByRole('status');
    await expect(status).toHaveText(activeTurnId ? 'Codex is working…' : /Ready since/);
    await recordStatus(page);
    for (let cycle = 0; cycle < 3; cycle++) {
      const reads = fixture.protocol.filter((call) => call.kind === 'history').length;
      const pending = fixture.deferHistory('session-1');
      const response = page.waitForResponse((response) => response.url().endsWith('/history'));
      try {
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect
          .poll(() => fixture.protocol.filter((call) => call.kind === 'history').length)
          .toBe(reads + 1);
        await expect(status).toHaveText(activeTurnId ? 'Codex is working…' : /Ready since/);
      } finally {
        pending.resolve(snapshot);
      }
      // Await the response before requesting another refresh; otherwise it coalesces.
      await (await response).finished();
    }
    const samples = await page.evaluate(() => Reflect.get(window, 'statusSamples') as string[]);
    expect(
      samples.every((text) =>
        activeTurnId ? text === 'Codex is working…' : text.startsWith('Ready since'),
      ),
    ).toBe(true);
  });
}

test('idle supervisor and child metadata do not trigger recovery in chat or the overview', async ({
  page,
}) => {
  await mockAuthenticatedStatus(page);
  const fixture = new ChatRelayFixture(page);
  const actor = {
    state: 'idle',
    observedAt: '2026-10-31T12:00:00Z',
    lastActivityAt: '2026-10-31T12:00:00Z',
  };
  const activity = {
    sessionId: 'session-1',
    root: actor,
    subagents: [{ ...actor, id: 'child-1', role: 'executor' }],
    aggregateSubagents: 'idle',
    confidence: 'fresh',
  };
  const session = {
    id: 'session-1',
    state: 'turnActive',
    threadId: 'thread-1',
    workspaceId: 'workspace-1',
    workspacePath: '/workspace',
    profile: 'default',
    activeTurnId: 'turn-1',
    pendingInteractions: [],
    agentActivity: activity,
    lastOrgPlan: { title: 'Status stability', filename: 'status.org', attached: true },
  };
  await fixture.install([session]);
  await page.route('**/api/sessions/session-1', (route) =>
    route.fulfill({ json: { ...session, currentSequence: 0 } }),
  );
  let activityRefreshes = 0;
  await page.route('**/api/sessions/session-1/activity/refresh', (route) => {
    activityRefreshes++;
    return route.fulfill({ json: { accepted: true } });
  });
  fixture.snapshot('session-1', chatSnapshot({ activeTurnId: 'turn-1' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Codex is working…');
  const reads = fixture.protocol.filter((call) => call.kind === 'history').length;
  const refreshes = activityRefreshes;
  await recordStatus(page);
  let sequence = 0;
  for (let cycle = 0; cycle < 5; cycle++) {
    fixture.event('session-1', ++sequence, 'autopilot.wait-registered', {
      waitId: `wait-${cycle}`,
    });
    fixture.event('session-1', ++sequence, 'org-plan.step-checkpointed', {
      stepId: `step-${cycle}`,
    });
    fixture.event('session-1', ++sequence, 'agent.activity.updated', activity);
    fixture.event('session-1', ++sequence, 'agentMessageCompleted', {
      itemId: 'progress',
      turnId: 'turn-1',
      phase: 'commentary',
      text: `Progress ${cycle}`,
    });
    await expect(page.getByText(`Progress ${cycle}`, { exact: true })).toBeVisible();
  }
  const samples = await page.evaluate(() => Reflect.get(window, 'statusSamples') as string[]);
  expect(samples.every((text) => text === 'Codex is working…')).toBe(true);
  expect(fixture.protocol.filter((call) => call.kind === 'history')).toHaveLength(reads);
  expect(activityRefreshes).toBe(refreshes);
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  const roster = page.getByLabel('Open sessions');
  await roster.getByText('Agents (2)', { exact: true }).click();
  await expect(roster.locator('.agents time')).toHaveCount(2);
  for (const label of await roster.locator('.agents time').allTextContents())
    expect(label).toContain('idle since');
});
