/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, test } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

async function waitForScrollToSettle(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    let stable = 0;
    let previous = window.scrollY;
    while (stable < 3) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (window.scrollY === previous) stable += 1;
      else {
        previous = window.scrollY;
        stable = 0;
      }
    }
  });
}

test('rapid session switch replaces A timeline with B timeline', async ({ page }) => {
  await mockAuthenticatedStatus(page);
  await page.addInitScript(() => {
    (window as Window & { __tailCalls?: Array<{ marker: string; behavior: string }> }).__tailCalls =
      [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (options) {
      if ((this as HTMLElement).classList.contains('chat-tail')) {
        const body = document.body.textContent ?? '';
        window.__tailCalls!.push({
          marker: body.includes('marker B') ? 'B' : body.includes('marker A') ? 'A' : 'none',
          behavior: typeof options === 'object' && options ? (options.behavior ?? '') : '',
        });
      }
      original.call(this, options);
    };
  });
  const session = (id: string, workspacePath: string) => ({
    id,
    state: 'ready',
    threadId: id,
    workspaceId: id,
    workspacePath,
    profile: 'default',
    activeTurnId: null,
    pendingInteractions: [],
  });
  await page.route('**/api/bootstrap', (r) =>
    r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: [],
        profiles: [],
        sessions: [session('session-a', '/A'), session('session-b', '/B')],
      }),
    }),
  );
  for (const [id, marker] of [
    ['session-a', 'marker A'],
    ['session-b', 'marker B'],
  ] as const) {
    await page.route(`**/api/sessions/${id}/history`, (r) =>
      r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          chatSnapshot({ items: [{ id: marker, kind: 'user', text: marker, turnId: id }] }),
        ),
      }),
    );
    await page.routeWebSocket(new RegExp(`/api/sessions/${id}/events`), () => {});
  }
  await page.route('**/api/sessions/recent-threads', (r) =>
    r.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat' }).click();
  await expect(page.getByText('marker A')).toBeVisible();
  await page.getByRole('button', { name: 'Sessions' }).click();
  const openSessions = page.getByLabel('Open sessions');
  await openSessions
    .getByRole('listitem')
    .filter({ hasText: '/B' })
    .getByRole('button', { name: /\/B/ })
    .click();
  await expect(page.getByText('marker B')).toBeVisible();
  await expect(page.getByText('marker A')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as Window & { __tailCalls?: Array<{ marker: string }> }).__tailCalls?.some(
          (call) => call.marker === 'B',
        ),
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(() => {
      const calls =
        (window as Window & { __tailCalls?: Array<{ marker: string }> }).__tailCalls ?? [];
      const firstB = calls.findIndex((call) => call.marker === 'B');
      return calls.slice(firstB + 1).every((call) => call.marker !== 'A');
    }),
  ).toBe(true);
});

for (const viewport of [
  { name: 'compact', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
]) {
  if (viewport.name === 'compact')
    test('resolved interaction followed by output stays at tail', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await mockAuthenticatedStatus(page);
      const pending = {
        requestId: 'approval-1',
        kind: 'commandApproval',
        turnId: 't-47',
        requestedAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
        payload: {},
      };
      await page.route('**/api/bootstrap', (r) =>
        r.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            workspaces: [],
            profiles: [],
            sessions: [
              {
                id: 'session-1',
                state: 'ready',
                threadId: 't',
                workspaceId: 'w',
                workspacePath: '/w',
                profile: 'default',
                activeTurnId: 't-47',
                pendingInteractions: [pending],
              },
            ],
          }),
        }),
      );
      await page.route('**/api/sessions/session-1/history', (r) =>
        r.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(
            chatSnapshot({
              activeTurnId: 't-47',
              items: Array.from({ length: 48 }, (_, id) => ({
                id: `m-${id}`,
                kind: 'user',
                text: `message ${id}`,
                turnId: `t-${id}`,
              })),
              interactions: [pending],
            }),
          ),
        }),
      );
      await page.route('**/api/sessions/recent-threads', (r) =>
        r.fulfill({ contentType: 'application/json', body: '[]' }),
      );
      let socket: { send(m: string): void } | undefined;
      await page.routeWebSocket(/\/api\/sessions\/session-1\/events/, (ws) => (socket = ws));
      await page.route('**/api/sessions/session-1/interactions/approval-1', (r) =>
        r.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({ accepted: true }),
        }),
      );
      await page.goto('/');
      await page.getByRole('button', { name: 'Chat' }).click();
      await page.getByRole('button', { name: 'Approve' }).click();
      await expect(page.locator('[data-interaction-state="resolved"]')).toContainText('Approved');
      socket!.send(
        JSON.stringify({
          type: 'relay.event',
          event: {
            sequence: 1,
            type: 'agentMessageDelta',
            payload: { text: 'after approval', phase: 'final_answer' },
          },
        }),
      );
      await expect(page.getByText('after approval')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Send prompt' })).toBeVisible();
    });
  if (viewport.name === 'compact')
    test('reduced motion uses instant tail scrolling', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript(() => {
        (window as Window & { __tailBehavior?: string }).__tailBehavior = '';
        const original = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function (options) {
          if ((this as HTMLElement).classList.contains('chat-tail'))
            window.__tailBehavior =
              typeof options === 'object' && options ? (options.behavior ?? '') : '';
          original.call(this, options);
        };
      });
      await mockAuthenticatedStatus(page);
      await page.route('**/api/bootstrap', (r) =>
        r.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            workspaces: [],
            profiles: [],
            sessions: [
              {
                id: 'session-1',
                state: 'ready',
                threadId: 't',
                workspaceId: 'w',
                workspacePath: '/w',
                profile: 'default',
                activeTurnId: null,
                pendingInteractions: [],
              },
            ],
          }),
        }),
      );
      await page.route('**/api/sessions/session-1/history', (r) =>
        r.fulfill({ contentType: 'application/json', body: JSON.stringify(chatSnapshot()) }),
      );
      await page.route('**/api/sessions/recent-threads', (r) =>
        r.fulfill({ contentType: 'application/json', body: '[]' }),
      );
      await page.routeWebSocket(/\/api\/sessions\/session-1\/events/, () => {});
      await page.goto('/');
      await page.getByRole('button', { name: 'Chat' }).click();
      await expect
        .poll(() =>
          page.evaluate(() => (window as Window & { __tailBehavior?: string }).__tailBehavior),
        )
        .toBe('auto');
    });
  if (viewport.name === 'compact')
    test('composer growth keeps reading position and completion returns tail', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await mockAuthenticatedStatus(page);
      await page.route('**/api/bootstrap', (r) =>
        r.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            workspaces: [],
            profiles: [],
            sessions: [
              {
                id: 'session-1',
                state: 'ready',
                threadId: 't',
                workspaceId: 'w',
                workspacePath: '/w',
                profile: 'default',
                activeTurnId: null,
                pendingInteractions: [],
              },
            ],
          }),
        }),
      );
      await page.route('**/api/sessions/session-1/history', (r) =>
        r.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(
            chatSnapshot({
              items: Array.from({ length: 48 }, (_, id) => ({
                id: `m-${id}`,
                kind: 'user',
                text: `message ${id}`,
              })),
            }),
          ),
        }),
      );
      await page.route('**/api/sessions/recent-threads', (r) =>
        r.fulfill({ contentType: 'application/json', body: '[]' }),
      );
      await page.routeWebSocket(/\/api\/sessions\/session-1\/events/, () => {});
      await page.goto('/');
      await page.getByRole('button', { name: 'Chat' }).click();
      const prompt = page.getByRole('textbox', { name: 'Prompt' });
      await prompt.focus();
      await page.setViewportSize({ width: 390, height: 500 });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await page.evaluate(() => {
        (window as Window & { __tailCalls?: number }).__tailCalls = 0;
        const original = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function (...args) {
          if ((this as HTMLElement).classList.contains('chat-tail')) window.__tailCalls! += 1;
          original.apply(this, args as Parameters<Element['scrollIntoView']>);
        };
      });
      const beforeMetrics = await page.evaluate(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>('#message')!;
        const tail = document.querySelector<HTMLElement>('.chat-tail')!;
        return {
          focus: document.activeElement?.id,
          textarea: textarea.getBoundingClientRect().toJSON(),
          tail: tail.getBoundingClientRect().toJSON(),
          scrollHeight: textarea.scrollHeight,
          clientHeight: textarea.clientHeight,
        };
      });
      await prompt.fill('line\n'.repeat(12));
      const afterMetrics = await page.evaluate(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>('#message')!;
        return {
          y: window.scrollY,
          tailCalls: (window as Window & { __tailCalls?: number }).__tailCalls,
          focus: document.activeElement?.id,
          scrollHeight: textarea.scrollHeight,
          clientHeight: textarea.clientHeight,
        };
      });
      expect(afterMetrics.tailCalls).toBe(0);
      expect(afterMetrics.focus).toBe('message');
      expect(afterMetrics.scrollHeight).toBeGreaterThan(beforeMetrics.scrollHeight);
      expect((await prompt.boundingBox())!.y).toBeLessThan(500);
    });
  test(`explicit send returns to tail before its HTTP response (${viewport.name})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockAuthenticatedStatus(page);
    await page.route('**/api/bootstrap', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          workspaces: [],
          profiles: [],
          sessions: [
            {
              id: 'session-1',
              state: 'ready',
              threadId: 't',
              workspaceId: 'w',
              workspacePath: '/workspace',
              profile: 'default',
              activeTurnId: null,
              pendingInteractions: [],
            },
          ],
        }),
      }),
    );
    await page.route('**/api/sessions/session-1/history', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          chatSnapshot({
            items: Array.from({ length: 48 }, (_, id) => ({
              id: `m-${id}`,
              kind: 'user',
              text: `message ${id}`,
              turnId: `t-${id}`,
            })),
          }),
        ),
      }),
    );
    await page.route('**/api/sessions/recent-threads', (route) =>
      route.fulfill({ contentType: 'application/json', body: '[]' }),
    );
    await page.routeWebSocket(/\/api\/sessions\/session-1\/events/, () => {});
    let requests = 0;
    let fulfill: (() => Promise<void>) | undefined;
    await page.route('**/api/sessions/session-1/turns', (route) => {
      requests += 1;
      fulfill = () =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ activeTurnId: 'turn-new' }),
        });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Chat' }).click();
    await waitForScrollToSettle(page);
    await page.mouse.wheel(0, -2000);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.getByRole('textbox', { name: 'Prompt' }).fill('send while reading');
    await page.getByRole('button', { name: 'Send prompt' }).click();
    await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('');
    await expect.poll(() => requests).toBe(1);
    await expect(page.getByText('send while reading')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send prompt' })).toBeVisible();
    await fulfill?.();
    expect(requests).toBe(1);
  });
  test(`follow-tail follows streaming but preserves reading position (${viewport.name})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockAuthenticatedStatus(page);
    await page.route('**/api/bootstrap', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          workspaces: [],
          profiles: [],
          sessions: [
            {
              id: 'session-1',
              state: 'ready',
              threadId: 't',
              workspaceId: 'w',
              workspacePath: '/workspace',
              profile: 'default',
              activeTurnId: 'turn-1',
              pendingInteractions: [],
            },
          ],
        }),
      }),
    );
    await page.route('**/api/sessions/session-1/history', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          chatSnapshot({
            activeTurnId: 'turn-1',
            items: Array.from({ length: 48 }, (_, id) => ({
              id: `m-${id}`,
              kind: 'user',
              text: `message ${id}`,
              turnId: `t-${id}`,
            })),
          }),
        ),
      }),
    );
    await page.route('**/api/sessions/recent-threads', (route) =>
      route.fulfill({ contentType: 'application/json', body: '[]' }),
    );
    let socket: { send(message: string): void } | undefined;
    await page.routeWebSocket(/\/api\/sessions\/session-1\/events/, (ws) => {
      socket = ws;
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Chat' }).click();
    await expect(page.getByText('message 47')).toBeVisible();
    await expect.poll(() => socket).toBeTruthy();
    socket!.send(
      JSON.stringify({
        type: 'relay.event',
        event: {
          sequence: 1,
          type: 'agentMessageDelta',
          payload: { text: 'tail stream', phase: 'final_answer' },
        },
      }),
    );
    await expect(page.getByText('tail stream')).toBeVisible();
    const tailY = await page.evaluate(() => window.scrollY);
    expect(await page.locator('.chat-tail').boundingBox()).toBeTruthy();
    await waitForScrollToSettle(page);
    await page.mouse.wheel(0, -2_000);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeLessThan(tailY);
    expect((await page.locator('.chat-tail').boundingBox())?.y ?? 0).toBeGreaterThan(
      viewport.height,
    );
    socket!.send(
      JSON.stringify({
        type: 'relay.event',
        event: {
          sequence: 2,
          type: 'agentMessageDelta',
          payload: { text: ' reading stream', phase: 'final_answer' },
        },
      }),
    );
    await expect(page.locator('.answer-turn')).toContainText('reading stream');
    socket!.send(
      JSON.stringify({
        type: 'relay.event',
        event: { sequence: 2, type: 'agentMessageDelta', payload: { text: 'duplicate' } },
      }),
    );
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThanOrEqual(2);
    expect(tailY).toBeGreaterThan(0);
  });
  test(`follow-tail initial bottom and actionable clearance (${viewport.name})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockAuthenticatedStatus(page);
    await page.route('**/api/bootstrap', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          workspaces: [],
          profiles: [],
          sessions: [
            {
              id: 'session-1',
              state: 'ready',
              threadId: 't',
              workspaceId: 'w',
              workspacePath: '/workspace',
              profile: 'default',
              activeTurnId: null,
              pendingInteractions: [],
            },
          ],
        }),
      }),
    );
    await page.route('**/api/sessions/session-1/history', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          chatSnapshot({
            items: Array.from({ length: 24 }, (_, id) => ({
              id: `m-${id}`,
              kind: 'user',
              text: `message ${id}`,
              turnId: `t-${id}`,
            })),
          }),
        ),
      }),
    );
    await page.route('**/api/sessions/recent-threads', (route) =>
      route.fulfill({ contentType: 'application/json', body: '[]' }),
    );
    await page.routeWebSocket(/\/api\/sessions\/session-1\/events/, () => {});
    await page.goto('/');
    await page.getByRole('button', { name: 'Chat' }).click();
    await expect(page.getByText('message 23')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send prompt' })).toBeVisible();
    await page.screenshot({
      path: `output/playwright/chat-follow-tail-initial-${viewport.name}.png`,
      fullPage: false,
    });
  });
}
