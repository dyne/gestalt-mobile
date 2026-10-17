/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test, expect } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

for (const width of [390, 1280]) {
  test(`Autopilot blocker opens focused independent DEBUG at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockAuthenticatedStatus(page);
    const problem = {
      requestId: 'attention-1',
      turnId: 'blocked-turn',
      requestedAt: '2026-10-17T08:10:33Z',
      attention: {
        reason: 'externalState',
        resumeCondition: 'externalStateChanged',
        summary: 'Installed guard mismatch.',
        requestedAction: 'Reconcile compatible tooling.',
      },
      supervisorReport:
        'The explicit single-suspension restriction was ignored. See report.md for the reproduction.',
    };
    const source = {
      id: 'source',
      threadId: 'source-thread',
      state: 'ready',
      workspaceId: 'workspace',
      workspacePath: '/work/source',
      profile: 'default',
      provider: 'codex',
      activeTurnId: null,
      autopilot: {
        enabled: false,
        state: 'attentionRequired',
        reason: 'attentionRequired',
        retry: { position: 0, limit: 3 },
        updatedAt: problem.requestedAt,
      },
      pendingInteractions: [
        {
          requestId: problem.requestId,
          kind: 'orgPlanAttention',
          turnId: problem.turnId,
          requestedAt: problem.requestedAt,
          payload: problem.attention,
          supervisorReport: problem.supervisorReport,
        },
      ],
    };
    const context = {
      handoffTrace: null,
      control: null,
      mobileSession: source.id,
      codexThread: source.threadId,
      capturedAt: problem.requestedAt,
      versions: [],
    };
    const debug = {
      ...source,
      id: 'debug',
      threadId: 'debug-thread',
      workspacePath: '/work/debug',
      pendingInteractions: [],
      autopilot: undefined,
      selfDebug: {
        context,
        tracePath: 'traces/debug.json',
        agent: { name: 'root', model: 'configured-model' },
      },
    };
    let creates = 0;
    let resolutions = 0;
    let rejectContext = false;
    await page.route('**/api/bootstrap', (route) =>
      route.fulfill({ json: { workspaces: [], profiles: [], sessions: [source] } }),
    );
    await page.route('**/api/sessions', (route) =>
      route.fulfill({ json: creates ? [source, debug] : [source] }),
    );
    await page.route('**/api/sessions/recent', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/sessions/source', (route) => route.fulfill({ json: source }));
    await page.route('**/api/sessions/debug', (route) => route.fulfill({ json: debug }));
    await page.route('**/api/sessions/*/history', (route) =>
      route.fulfill({ json: chatSnapshot() }),
    );
    await page.route('**/api/sessions/*/activity/refresh', (route) =>
      route.fulfill({ status: 204 }),
    );
    await page.route('**/api/sessions/source/attention', (route) =>
      route.fulfill({ json: problem }),
    );
    await page.route('**/api/sessions/source/autopilot', (route) =>
      route.fulfill({ json: { autopilot: source.autopilot } }),
    );
    await page.route('**/api/sessions/source/attention/*/resolve', (route) => {
      resolutions++;
      return route.fulfill({ json: { accepted: true } });
    });
    await page.route('**/api/sessions/source/debug*', (route) => {
      if (route.request().method() === 'GET') {
        expect(new URL(route.request().url()).searchParams.get('attentionRequestId')).toBe(
          problem.requestId,
        );
        return rejectContext
          ? route.fulfill({
              status: 409,
              json: { code: 'DEBUG_ATTENTION_CHANGED', title: 'This blocker is no longer active.' },
            })
          : route.fulfill({ json: { confirmationId: 'confirmed', context, problem } });
      }
      expect(route.request().postDataJSON()).toEqual({ confirmationId: 'confirmed' });
      creates++;
      return route.fulfill({ status: 202, json: debug });
    });
    await page.routeWebSocket(/\/api\/sessions\/[^/]+\/events/, () => {});
    await page.goto('/');
    // Exercise the Sessions entry point on mobile and the inline Chat alert on desktop.
    if (width === 1280) await page.getByRole('button', { name: 'Open', exact: true }).click();
    const blocker = page.getByRole('alert').filter({ hasText: 'Autopilot needs your attention' });
    const button = blocker.getByRole('button', { name: 'DEBUG', exact: true });
    await expect(button).toBeVisible();
    await button.click();
    const dialog = page.getByRole('dialog', {
      name: 'Confirm spawning a new Gestalt DEBUG session?',
    });
    await expect(dialog).toContainText(problem.supervisorReport);
    await expect(dialog).toContainText('The blocked session stays paused.');
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: `output/playwright/attention-debug-${width}.png` });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(button).toBeFocused();
    expect(creates).toBe(0);
    rejectContext = true;
    await button.click();
    await expect(page.getByText('This blocker is no longer active.')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    rejectContext = false;
    await button.click();
    await dialog.getByRole('button', { name: 'Start Self DEBUG' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Chat', pressed: true })).toBeVisible();
    expect(creates).toBe(1);
    expect(resolutions).toBe(0);
  });
}
