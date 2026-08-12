/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture } from './chat-relay-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

async function waitForSettledScroll(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let stableFrames = 0;
        let previous = window.scrollY;
        const observe = () => {
          const current = window.scrollY;
          stableFrames = current === previous ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames === 3) resolve();
          else requestAnimationFrame(observe);
        };
        requestAnimationFrame(observe);
      }),
  );
}

async function centerEvidence(page: Page, target: Locator): Promise<void> {
  await target.evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'auto' }));
  await waitForSettledScroll(page);
  const [targetBox, headerBox, navigationBox] = await Promise.all([
    target.boundingBox(),
    page.locator('.app-header').boundingBox(),
    page.getByLabel('Primary').boundingBox(),
  ]);
  expect(targetBox).not.toBeNull();
  expect(headerBox).not.toBeNull();
  expect(navigationBox).not.toBeNull();
  expect(targetBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
  expect(targetBox!.y + targetBox!.height).toBeLessThanOrEqual(navigationBox!.y);
}

test('retains an optimistic prompt while turn HTTP is deferred', async ({ page }) => {
  await mockAuthenticatedStatus(page);
  const fixture = new ChatRelayFixture(page);
  await fixture.install([
    {
      id: 'session-1',
      state: 'ready',
      threadId: 'thread-1',
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
      profile: 'default',
      activeTurnId: null,
      pendingInteractions: [],
    },
  ]);
  fixture.deferTurn('session-1');
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat' }).click();
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('optimistic prompt');
  await page.getByRole('button', { name: 'Send prompt' }).click();
  await expect(prompt).toHaveValue('');
  await expect(page.getByText('optimistic prompt')).toBeVisible();
  const promptHandle = await page.getByText('optimistic prompt').elementHandle();
  await expect.poll(() => fixture.commands.length).toBe(1);
  expect(fixture.commands[0]).toMatchObject({
    kind: 'turn',
    sessionId: 'session-1',
    body: { text: 'optimistic prompt' },
  });
  expect(fixture.commands[0]?.idempotencyKey).toBeTruthy();
  await expect.poll(() => fixture.sockets.has('session-1')).toBe(true);
  fixture.event('session-1', 1, 'interaction.requested', {
    requestId: 'approval-1',
    kind: 'commandApproval',
    turnId: 'turn-1',
    payload: {},
  });
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  expect(await promptHandle?.evaluate((node) => node.isConnected)).toBe(true);
  fixture.snapshot(
    'session-1',
    chatSnapshot({
      baseSequence: 2,
      currentSequence: 2,
      activeTurnId: 'turn-1',
      interactions: [
        {
          requestId: 'approval-1',
          kind: 'commandApproval',
          turnId: 'turn-1',
          requestedAt: '2026-01-01T00:00:00.000Z',
          resolvedAt: null,
          payload: {},
        },
      ],
    }),
  );
  fixture.deferInteraction('approval-1');
  fixture.event('session-1', 3, 'agentMessageDelta', {
    text: 'recovered final',
    phase: 'final_answer',
  });
  await expect(page.getByText('recovered final')).toBeVisible();
  await expect(page.getByText('optimistic prompt')).toBeVisible();
  expect(await promptHandle?.evaluate((node) => node.isConnected)).toBe(true);
  fixture.turns
    .get('session-1')
    ?.resolve({ kind: 'fulfill', status: 202, body: { activeTurnId: 'turn-1' } });
  expect(fixture.commands).toHaveLength(1);
});

test('suppresses a double-click while an interaction response is deferred', async ({ page }) => {
  await mockAuthenticatedStatus(page);
  const fixture = new ChatRelayFixture(page);
  await fixture.install([
    {
      id: 'session-1',
      state: 'ready',
      threadId: 'thread-1',
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
      profile: 'default',
      activeTurnId: 'turn-1',
      pendingInteractions: [],
    },
  ]);
  fixture.snapshot(
    'session-1',
    chatSnapshot({
      activeTurnId: 'turn-1',
      items: [{ id: 'prompt-1', kind: 'user', text: 'prompt', turnId: 'turn-1' }],
      interactions: [
        {
          requestId: 'approval-1',
          kind: 'commandApproval',
          turnId: 'turn-1',
          requestedAt: '2026-01-01T00:00:00.000Z',
          resolvedAt: null,
          payload: {},
        },
      ],
    }),
  );
  fixture.deferInteraction('approval-1');
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat' }).click();
  const approve = page.getByRole('button', { name: 'Approve' });
  const card = await approve.locator('xpath=ancestor::article').elementHandle();
  await approve.evaluate((button) => {
    button.click();
    button.click();
  });
  await expect.poll(() => fixture.commands.length).toBe(1);
  expect(fixture.commands[0]).toMatchObject({ kind: 'interaction', requestId: 'approval-1' });
  expect(fixture.commands[0]?.idempotencyKey).toBeTruthy();
  await expect(approve).toBeDisabled();
  expect(await card?.evaluate((node) => node.isConnected)).toBe(true);
  fixture.interactions.get('approval-1')?.resolve({ kind: 'abort' });
  const retry = page.getByRole('button', { name: 'Retry' });
  await expect(retry).toBeVisible();
  expect(await card?.evaluate((node) => node.isConnected)).toBe(true);
  const second = fixture.deferInteraction('approval-1');
  await retry.click();
  await expect.poll(() => fixture.commands.length).toBe(2);
  expect(fixture.commands[1]?.idempotencyKey).toBe(fixture.commands[0]?.idempotencyKey);
  expect(fixture.commands[1]?.body).toEqual(fixture.commands[0]?.body);
  second.resolve({ kind: 'fulfill', status: 202, body: { accepted: true } });
  await expect(page.locator('[data-interaction-state="resolved"]')).toContainText('Approved');
  expect(await card?.evaluate((node) => node.isConnected)).toBe(true);
  fixture.event('session-1', 1, 'interaction.requested', {
    requestId: 'approval-1',
    kind: 'commandApproval',
    turnId: 'turn-1',
    payload: {},
  });
  fixture.event('session-1', 2, 'interaction.resolved', {
    requestId: 'approval-1',
    outcome: 'approved',
  });
  await expect(page.locator('[data-interaction-state="resolved"]')).toHaveCount(1);
});

test('late A history cannot replace selected B timeline', async ({ page }) => {
  await mockAuthenticatedStatus(page);
  const fixture = new ChatRelayFixture(page);
  const session = (id: string, path: string) => ({
    id,
    state: 'ready',
    threadId: id,
    workspaceId: id,
    workspacePath: path,
    profile: 'default',
    activeTurnId: null,
    pendingInteractions: [],
  });
  await fixture.install([session('session-a', '/A'), session('session-b', '/B')]);
  const a = fixture.deferHistory('session-a');
  const b = fixture.deferHistory('session-b');
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat' }).click();
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page
    .getByLabel('Open sessions')
    .getByRole('listitem')
    .filter({ hasText: '/B' })
    .getByRole('button', { name: /\/B/ })
    .click();
  b.resolve(chatSnapshot({ items: [{ id: 'b', kind: 'user', text: 'marker B', turnId: 'b' }] }));
  await expect(page.getByText('marker B')).toBeVisible();
  a.resolve(chatSnapshot({ items: [{ id: 'a', kind: 'user', text: 'marker A', turnId: 'a' }] }));
  await expect(page.getByText('marker B')).toBeVisible();
  await expect(page.getByText('marker A')).toHaveCount(0);
});

test('shows working streamed state before terminal resume recovery', async ({ page }) => {
  await mockAuthenticatedStatus(page);
  const fixture = new ChatRelayFixture(page);
  await fixture.install([
    {
      id: 'session-1',
      state: 'ready',
      threadId: 'thread-1',
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
      profile: 'default',
      activeTurnId: 'turn-1',
      pendingInteractions: [],
    },
  ]);
  fixture.snapshot(
    'session-1',
    chatSnapshot({
      activeTurnId: 'turn-1',
      items: [{ id: 'prompt', kind: 'user', text: 'resume prompt', turnId: 'turn-1' }],
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat' }).click();
  await expect.poll(() => fixture.sockets.has('session-1')).toBe(true);
  fixture.event('session-1', 1, 'agentMessageDelta', {
    text: 'working marker',
    phase: 'commentary',
  });
  await expect(page.getByText('working marker')).toBeAttached();
  await expect(page.getByText('resume final')).toHaveCount(0);
  fixture.snapshot(
    'session-1',
    chatSnapshot({
      baseSequence: 2,
      currentSequence: 2,
      activeTurnId: null,
      items: [
        { id: 'prompt', kind: 'user', text: 'resume prompt', turnId: 'turn-1' },
        {
          id: 'final',
          kind: 'agent',
          text: 'resume final',
          turnId: 'turn-1',
          phase: 'final_answer',
        },
      ],
      turns: [{ id: 'turn-1', items: [], startedAt: 1, completedAt: 2 }],
    }),
  );
  const promptHandle = await page.getByText('resume prompt').elementHandle();
  expect(await page.getByText('working marker').elementHandle()).toBeTruthy();
  const oldSocket = fixture.sockets.get('session-1');
  fixture.close('session-1');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('resume final')).toBeVisible();
  await expect.poll(() => fixture.sockets.get('session-1') !== oldSocket).toBe(true);
  expect(await promptHandle?.evaluate((node) => node.isConnected)).toBe(true);
  await expect(page.getByRole('button', { name: 'Interrupt' })).toHaveCount(0);
  const final = page.getByText('resume final');
  const finalHandle = await final.elementHandle();
  const box = await final.boundingBox();
  const scrollY = await page.evaluate(() => window.scrollY);
  fixture.event('session-1', 3, 'session.updated', { activeTurnId: null });
  fixture.event('session-1', 4, 'turnCompleted', null);
  fixture.event('session-1', 4, 'turnCompleted', null);
  await expect(final).toHaveCount(1);
  expect(await finalHandle?.evaluate((node) => node.isConnected)).toBe(true);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrollY)).toBeLessThanOrEqual(2);
  expect(await final.boundingBox()).toEqual(box);
});

for (const shot of [
  { name: 'compact', width: 390, height: 844, fontScale: 100 },
  { name: 'desktop', width: 1280, height: 800, fontScale: 100 },
  { name: 'compact', width: 390, height: 844, fontScale: 200 },
])
  test(`captures ${shot.name} ${shot.fontScale} pending interaction state`, async ({ page }) => {
    await page.setViewportSize({ width: shot.width, height: shot.height });
    await mockAuthenticatedStatus(page);
    const fixture = new ChatRelayFixture(page);
    await fixture.install([
      {
        id: 'session-1',
        state: 'ready',
        threadId: 'thread-1',
        workspaceId: 'workspace-1',
        workspacePath: '/workspace',
        profile: 'default',
        activeTurnId: 'turn-1',
        pendingInteractions: [],
      },
    ]);
    fixture.snapshot(
      'session-1',
      chatSnapshot({
        activeTurnId: 'turn-1',
        items: [{ id: 'p', kind: 'user', text: 'pending prompt', turnId: 'turn-1' }],
        interactions: [
          {
            requestId: 'approval-1',
            kind: 'commandApproval',
            turnId: 'turn-1',
            requestedAt: '2026-01-01T00:00:00.000Z',
            resolvedAt: null,
            payload: {},
          },
        ],
      }),
    );
    fixture.deferInteraction('approval-1');
    await page.goto('/');
    if (shot.fontScale === 200)
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });
    await page.getByRole('button', { name: 'Chat' }).click();
    const approve = page.getByRole('button', { name: 'Approve' });
    await expect(approve).toBeVisible();
    expect(
      (await approve.boundingBox())!.y + (await approve.boundingBox())!.height,
    ).toBeLessThanOrEqual(shot.height);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await waitForSettledScroll(page);
    if (shot.fontScale === 100)
      await page.screenshot({
        path: `output/playwright/chat-timeline-pending-${shot.name}-${shot.fontScale}.png`,
      });
    await approve.click();
    await expect.poll(() => fixture.commands.length).toBe(1);
    await expect(page.locator('[data-interaction-state="submitting"]')).toBeVisible();
    await expect(approve).toBeDisabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await waitForSettledScroll(page);
    if (shot.fontScale === 100)
      await page.screenshot({
        path: `output/playwright/chat-timeline-submitting-${shot.name}-${shot.fontScale}.png`,
      });
    fixture.interactions.get('approval-1')?.resolve({ kind: 'abort' });
    const retry = page.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await waitForSettledScroll(page);
    if (shot.fontScale === 100)
      await page.screenshot({
        path: `output/playwright/chat-timeline-failed-${shot.name}-${shot.fontScale}.png`,
      });
    const replacement = fixture.deferInteraction('approval-1');
    await retry.click();
    await expect.poll(() => fixture.commands.length).toBe(2);
    expect(fixture.commands[1]?.idempotencyKey).toBe(fixture.commands[0]?.idempotencyKey);
    replacement.resolve({ kind: 'fulfill', status: 202, body: { accepted: true } });
    await expect(page.locator('[data-interaction-state="resolved"]')).toContainText('Approved');
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await waitForSettledScroll(page);
    if (shot.fontScale === 200) {
      const [interruptBox, navigationBox] = await Promise.all([
        page.getByRole('button', { name: 'Interrupt' }).boundingBox(),
        page.getByLabel('Primary').boundingBox(),
      ]);
      expect(interruptBox).not.toBeNull();
      expect(navigationBox).not.toBeNull();
      expect(interruptBox!.y).toBeGreaterThanOrEqual(0);
      expect(interruptBox!.y + interruptBox!.height).toBeLessThanOrEqual(navigationBox!.y);
      await centerEvidence(
        page,
        page.locator('[data-interaction-state="resolved"]').locator('xpath=ancestor::article'),
      );
    }
    await page.screenshot({
      path: `output/playwright/chat-timeline-resolved-${shot.name}-${shot.fontScale}.png`,
    });
    fixture.event('session-1', 1, 'agentMessageDelta', {
      itemId: 'commentary-1',
      turnId: 'turn-1',
      text: 'working screenshot',
      phase: 'commentary',
    });
    await expect(page.getByText('working screenshot')).toBeAttached();
    await expect(page.getByText('working', { exact: true })).toBeVisible();
    await expect(page.locator('.progress-turn details')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Interrupt' })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await waitForSettledScroll(page);
    if (shot.fontScale === 100)
      await page.screenshot({
        path: `output/playwright/chat-timeline-working-${shot.name}-${shot.fontScale}.png`,
      });
    fixture.event('session-1', 2, 'agentMessageDelta', {
      itemId: 'answer-1',
      turnId: 'turn-1',
      text: 'finished screenshot',
      phase: 'final_answer',
    });
    fixture.event('session-1', 3, 'session.updated', { activeTurnId: null });
    fixture.event('session-1', 4, 'turnCompleted', null);
    await expect(page.getByText('finished screenshot')).toBeVisible();
    await expect(page.getByRole('button', { name: 'commentary' })).toBeVisible();
    await expect(page.getByText('working screenshot')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Interrupt' })).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('Ready');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await waitForSettledScroll(page);
    if (shot.fontScale === 200) {
      const [promptBox, sendBox, navigationBox] = await Promise.all([
        page.getByRole('textbox', { name: 'Prompt' }).boundingBox(),
        page.getByRole('button', { name: 'Send prompt' }).boundingBox(),
        page.getByLabel('Primary').boundingBox(),
      ]);
      expect(promptBox).not.toBeNull();
      expect(sendBox).not.toBeNull();
      expect(navigationBox).not.toBeNull();
      expect(page.getByText('finished screenshot')).toBeVisible();
      expect(promptBox!.y).toBeGreaterThanOrEqual(0);
      expect(sendBox!.y).toBeGreaterThanOrEqual(0);
      expect(promptBox!.y + promptBox!.height).toBeLessThanOrEqual(navigationBox!.y);
      expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(navigationBox!.y);
      await centerEvidence(
        page,
        page.getByText('finished screenshot').locator('xpath=ancestor::section[1]'),
      );
    }
    await page.screenshot({
      path: `output/playwright/chat-timeline-finished-${shot.name}-${shot.fontScale}.png`,
    });
  });
