/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

test.beforeEach(async ({ page }) => mockAuthenticatedStatus(page));

const sessions = Array.from({ length: 24 }, (_, index) => ({
  id: `session-${index + 1}`,
  state: 'ready',
  threadId: `thread-${index + 1}`,
  workspaceId: `workspace-${index + 1}`,
  workspacePath: `/projects/workspace-${index + 1}`,
  profile: 'default',
  activeTurnId: null,
}));

test('focuses the prompt when Chat is selected on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: [], profiles: [], sessions: [sessions[0]] }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(chatSnapshot()),
    }),
  );
  await page.route('**/api/sessions/session-1/plan', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/skill-profiles', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ profiles: [] }) }),
  );
  await page.routeWebSocket(
    /ws:\/\/127\.0\.0\.1:\d+\/api\/sessions\/session-1\/events\?after=\d+/,
    () => {},
  );

  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: 'Primary' });
  await navigation.getByRole('button', { name: 'Chat' }).click();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeFocused();
});

test('opens Chat and every other tab at the top', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: [], profiles: [], sessions }),
    }),
  );
  await page.route('**/api/sessions/session-1/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        chatSnapshot({
          items: Array.from({ length: 40 }, (_, index) => ({
            id: `message-${index + 1}`,
            kind: index % 2 === 0 ? 'user' : 'agent',
            text: `Message ${index + 1}: enough content to keep the Chat view scrollable.`,
            occurredAt: index + 1,
          })),
        }),
      ),
    }),
  );
  await page.route('**/api/sessions/session-1/plan', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/skill-profiles', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ profiles: [] }) }),
  );
  await page.routeWebSocket(
    /ws:\/\/127\.0\.0\.1:\d+\/api\/sessions\/session-1\/events\?after=\d+/,
    () => {},
  );

  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: 'Primary' });
  const chat = navigation.getByRole('button', { name: 'Chat' });
  await chat.click();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeFocused();
  await expect(page.getByText('Message 40:', { exact: false })).toBeAttached();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  const firstMessage = page.getByText('Message 40:', { exact: false });
  expect((await prompt.boundingBox())!.y).toBeLessThan((await firstMessage.boundingBox())!.y);
  await page.evaluate(() => window.scrollTo({ top: 1000 }));

  await navigation.getByRole('button', { name: 'Sessions' }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await navigation.getByRole('button', { name: 'Git' }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

for (const detached of [false, true]) {
  test(`delayed history keeps the prompt at the top (${detached ? 'detached' : 'tab'})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/bootstrap', (route) =>
      route.fulfill({
        json: { workspaces: [], profiles: [], sessions: [sessions[0]] },
      }),
    );
    let releaseHistory: (() => void) | undefined;
    const historyReady = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    await page.route('**/api/sessions/session-1/history', async (route) => {
      await historyReady;
      await route.fulfill({
        json: chatSnapshot({
          items: Array.from({ length: 48 }, (_, index) => ({
            id: `delayed-${index}`,
            kind: 'user',
            text: `Delayed message ${index}`,
            turnId: `turn-${index}`,
            occurredAt: index + 1,
          })),
        }),
      });
    });
    await page.route('**/api/sessions/recent-threads', (route) => route.fulfill({ json: [] }));
    await page.routeWebSocket(/\/api\/sessions\/session-1\/events/, () => {});
    await page.goto(detached ? '/?chat-session=session-1' : '/');
    if (!detached) await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeInViewport();
    releaseHistory!();
    await expect(page.getByText('Delayed message 47', { exact: true })).toBeAttached();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeInViewport();
    if (detached) {
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });
      await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeInViewport();
      const overflow = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        elements: [...document.querySelectorAll<HTMLElement>('body *')]
          .filter((element) => element.getBoundingClientRect().right > window.innerWidth)
          .map((element) => ({
            tag: element.tagName,
            class: element.className,
            width: element.getBoundingClientRect().width,
          })),
      }));
      expect(overflow.width, JSON.stringify(overflow)).toBeLessThanOrEqual(390);
      await page.screenshot({ path: 'output/playwright/chat-top-detached-zoom.png' });
    }
    if (!detached) {
      await page.evaluate(() => window.scrollTo({ top: 1200 }));
      await page.getByRole('button', { name: 'Sessions', exact: true }).click();
      await page.getByRole('button', { name: 'Chat', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeInViewport();
    }
  });
}
