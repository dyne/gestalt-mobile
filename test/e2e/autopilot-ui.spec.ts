/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir, rm } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';
import { expectNoHorizontalOverflow } from './theme-evidence.js';
import { THEME_STORAGE_KEY } from '../../src/client/features/theme/theme-registry.js';

const evidence = '/tmp/gestalt-autopilot-evidence';
type State = 'disabled' | 'monitoring' | 'backoff' | 'attentionRequired' | 'completed';
type ContinuationPhase = 'scheduled' | 'backoff';
const viewports = [
  { name: '320x568', width: 320, height: 568 },
  { name: '390x844', width: 390, height: 844 },
  { name: '768x1024', width: 768, height: 1024 },
] as const;
const secret = 'NEVER-RENDER-AUTOPILOT-PROMPT-OR-SECRET';

function autopilot(state: State, reason?: string, continuationPhase?: ContinuationPhase) {
  const isScheduledContinuation = state === 'backoff' && continuationPhase === 'scheduled';
  return {
    state,
    enabled: state === 'monitoring' || state === 'backoff',
    reason,
    retry: {
      position:
        state === 'backoff'
          ? isScheduledContinuation
            ? 0
            : 2
          : state === 'attentionRequired'
            ? 3
            : 0,
      limit: 3,
    },
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...(state === 'backoff'
      ? {
          lastAutomaticAction: {
            controlId: 'control-1',
            summary: isScheduledContinuation
              ? 'Automatic continuation is scheduled.'
              : 'Automatic continuation is backing off.',
          },
        }
      : {}),
  };
}

const attention = {
  requestId: 'attention-1',
  kind: 'orgPlanAttention',
  turnId: 'turn-1',
  requestedAt: '2026-08-20T00:00:00.000Z',
  payload: {
    reason: 'hardBlock',
    summary: 'A required dependency is unavailable.',
    requestedAction: 'Restore it.',
    resumeCondition: 'dependencyInstalled',
  },
};

async function install(
  page: Page,
  state: State,
  reason?: string,
  hasAttention = state === 'attentionRequired',
  onsocket?: (socket: { send(message: string): void }) => void,
  awaitingChild = false,
  continuationPhase?: ContinuationPhase,
) {
  const session = {
    id: 'session-1',
    state: 'ready',
    threadId: 'thread-1',
    workspaceId: 'w',
    workspacePath: '/workspace',
    profile: 'default',
    activeTurnId: null,
    ...(awaitingChild
      ? {
          agentActivity: {
            sessionId: 'session-1',
            root: {
              state: 'awaitingAgent',
              observedAt: '2026-08-20T00:00:00.000Z',
              lastActivityAt: '2026-08-20T00:00:00.000Z',
            },
            subagents: [
              {
                id: 'child-1',
                nickname: 'Builder',
                state: 'working',
                observedAt: '2026-08-20T00:00:00.000Z',
                lastActivityAt: '2026-08-20T00:00:00.000Z',
              },
            ],
            aggregateSubagents: 'working',
            confidence: 'fresh',
          },
        }
      : {}),
    autopilot: autopilot(state, reason, continuationPhase),
    pendingInteractions: hasAttention ? [attention] : [],
  };
  await mockAuthenticatedStatus(page);
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: [], profiles: [], sessions: [session] }),
    }),
  );
  await page.route('**/api/sessions', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify([session]) }),
  );
  await page.route('**/api/sessions/session-1', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(session) }),
  );
  await page.route('**/api/sessions/session-1/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        chatSnapshot({
          items: [
            {
              id: 'automatic-1',
              kind: 'autopilot',
              controlId: 'control-1',
              occurredAt: Date.parse('2026-08-20T00:00:00.000Z'),
            },
          ],
          ...(state === 'backoff'
            ? {
                autopilotAudit: Array.from({ length: 4 }, (_, index) => ({
                  id: `audit-${continuationPhase ?? 'backoff'}-${index}`,
                  label:
                    continuationPhase === 'scheduled'
                      ? 'Autopilot scheduled a continuation'
                      : 'Autopilot is backing off',
                  occurredAt: Date.parse('2026-08-20T00:00:00.000Z') + index * 1000,
                  controlId: 'control-1',
                })),
              }
            : {}),
        }),
      ),
    }),
  );
  await page.route('**/api/sessions/session-1/autopilot', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ autopilot: autopilot(state, reason, continuationPhase) }),
    }),
  );
  await page.route('**/api/sessions/session-1/attention/attention-1/resolve', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ accepted: true }) }),
  );
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.routeWebSocket(/\/api\/sessions\/session-1\/events/, (socket) => onsocket?.(socket));
}

function captureBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

async function expectFocusedControlClearOfNavigation(
  page: Page,
  control: ReturnType<Page['getByRole']>,
) {
  await control.focus();
  await expect(control).toBeFocused();
  const [controlBox, navigationBox] = await Promise.all([
    control.boundingBox(),
    page.getByRole('navigation', { name: 'Primary' }).boundingBox(),
  ]);
  expect(controlBox).not.toBeNull();
  expect(navigationBox).not.toBeNull();
  expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(navigationBox!.y);
}

async function openEvidence(
  page: Page,
  options: {
    viewport: { width: number; height: number };
    theme: 'minimal-light' | 'minimal-dark';
    zoom: number;
  },
) {
  const errors = captureBrowserErrors(page);
  await page.setViewportSize(options.viewport);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(({ key, theme }) => localStorage.setItem(key, theme), {
    key: THEME_STORAGE_KEY,
    theme: options.theme,
  });
  await page.goto('/');
  if (options.zoom !== 100)
    await page.addStyleTag({ content: `html { font-size: ${options.zoom}% !important; }` });
  return errors;
}

const cases: ReadonlyArray<{
  name: string;
  state: State;
  reason?: string;
  text: string;
  attention?: boolean;
  continuationPhase?: ContinuationPhase;
}> = [
  { name: 'eligible-off', state: 'disabled', text: 'Autopilot: Off' },
  { name: 'monitoring', state: 'monitoring', text: 'Autopilot: Monitoring' },
  { name: 'root-awaiting-child', state: 'monitoring', text: 'Autopilot: Monitoring' },
  {
    name: 'scheduled-continuation',
    state: 'backoff',
    text: 'Waiting to continue',
    continuationPhase: 'scheduled',
  },
  { name: 'backoff', state: 'backoff', text: 'Retry 2 of 3', continuationPhase: 'backoff' },
  {
    name: 'retry-exhaustion',
    state: 'attentionRequired',
    reason: 'noPlanProgress',
    text: 'did not make durable progress',
    attention: false,
  },
  {
    name: 'tool-attention',
    state: 'attentionRequired',
    text: 'Paused for attention',
    attention: true,
  },
  {
    name: 'missing-plan-conflict',
    state: 'disabled',
    reason: 'planRequired',
    text: 'incomplete supervised plan is required',
  },
  {
    name: 'complete-plan',
    state: 'completed',
    reason: 'planComplete',
    text: 'Autopilot: Complete',
  },
  {
    name: 'resolved-attention',
    state: 'monitoring',
    text: 'Autopilot: Monitoring',
    attention: false,
  },
];

for (const item of cases) {
  test(`${item.name} is semantic, safe, and synchronized in Chat and Sessions`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await install(
      page,
      item.state,
      item.reason,
      item.attention,
      undefined,
      item.name === 'root-awaiting-child',
      item.continuationPhase,
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Chat' }).click();
    await expect(page.getByRole('region', { name: 'Autopilot' })).toContainText(item.text);
    if (item.name === 'monitoring') {
      await expect(page.getByTestId('autopilot-live-status')).toHaveText(
        'Autopilot status: Monitoring. Autopilot is monitoring this supervised plan.',
      );
      await expect(page.getByRole('region', { name: 'Autopilot' })).not.toContainText('Retry 0');
    }
    if (item.name === 'scheduled-continuation') {
      await expect(page.getByRole('region', { name: 'Autopilot' })).toContainText(
        'Waiting to continue',
      );
      await expect(page.getByRole('region', { name: 'Autopilot' })).not.toContainText('Retry');
      await expect(page.getByLabel('Chat messages')).toContainText(
        'Autopilot scheduled a continuation',
      );
      await expect(page.getByLabel('Chat messages')).not.toContainText('Autopilot is backing off');
    }
    if (item.name === 'backoff') {
      await expect(page.getByRole('region', { name: 'Autopilot' })).toContainText('Retry 2 of 3');
      await expect(page.getByLabel('Chat messages')).toContainText('Autopilot is backing off');
      await expect(page.getByLabel('Chat messages')).not.toContainText(
        'Autopilot scheduled a continuation',
      );
    }
    if (item.name === 'root-awaiting-child')
      await expect(page.getByLabel('Agent activity')).toContainText(
        'Supervisor: waiting for child',
      );
    const isEnabled = item.state === 'monitoring' || item.state === 'backoff';
    const control = page.getByRole('button', { name: isEnabled ? 'Pause' : 'Enable' });
    await expect(control).toHaveAttribute('aria-pressed', isEnabled ? 'true' : 'false');
    if (item.attention) {
      await expect(
        page.getByRole('alert', { name: 'Autopilot needs your attention' }),
      ).toContainText('Requested action');
      await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Disable Autopilot' })).toBeVisible();
    } else
      await expect(page.getByRole('alert', { name: 'Autopilot needs your attention' })).toHaveCount(
        0,
      );
    if (item.name === 'retry-exhaustion') {
      await expect(page.getByRole('alert', { name: 'Autopilot safety stop' })).toContainText(
        'There is no pending agent attention request',
      );
      await expect(page.getByRole('button', { name: 'Retry Autopilot' })).toBeVisible();
    }
    await expect(page.locator('body')).not.toContainText(secret);
    await page.getByRole('button', { name: 'Sessions' }).click();
    await expect(
      page.getByLabel('Open sessions').getByRole('region', { name: 'Autopilot' }),
    ).toContainText(item.text);
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });
}

for (const viewport of viewports)
  for (const [colorScheme, theme] of [
    ['light', 'minimal-light'],
    ['dark', 'minimal-dark'],
  ] as const) {
    test(`baseline monitoring evidence ${viewport.name} ${colorScheme}`, async ({ page }) => {
      await mkdir(evidence, { recursive: true });
      await install(page, 'monitoring');
      const errors = await openEvidence(page, { viewport, theme, zoom: 100 });
      await page.getByRole('button', { name: 'Chat' }).click();
      await expect(page.getByRole('region', { name: 'Autopilot' })).toContainText('Monitoring');
      await expectNoHorizontalOverflow(page);
      await page.screenshot({
        path: `${evidence}/baseline-monitoring-${viewport.name}-${colorScheme}.png`,
        fullPage: false,
      });
      expect(errors).toEqual([]);
    });
  }

for (const item of [
  { name: 'monitoring', state: 'monitoring' as const },
  { name: 'attention', state: 'attentionRequired' as const },
  { name: 'dense-audit', state: 'backoff' as const },
]) {
  test(`200 percent ${item.name} remains operable`, async ({ page }) => {
    await mkdir(evidence, { recursive: true });
    await install(page, item.state);
    const errors = await openEvidence(page, {
      viewport: { width: 390, height: 844 },
      theme: 'minimal-dark',
      zoom: 200,
    });
    await page.getByRole('button', { name: 'Chat' }).click();
    const control = page.getByRole('button', {
      name: item.state === 'backoff' || item.state === 'monitoring' ? 'Pause' : 'Enable',
    });
    await expectFocusedControlClearOfNavigation(page, control);
    await expect(control).toHaveCSS('min-height', '44px');
    if (item.name === 'attention') {
      const resume = page.getByRole('button', { name: 'Resume' });
      await expectFocusedControlClearOfNavigation(page, resume);
    }
    if (item.name === 'dense-audit') {
      await expect(
        page.getByLabel('Autopilot audit entry', { exact: true }).filter({ hasText: '4 times' }),
      ).toContainText('4 times');
      const timestamps = page.locator('summary', { hasText: 'Show 4 timestamps' });
      await timestamps.focus();
      await expect(timestamps).toBeFocused();
      await timestamps.press('Space');
      await expect(timestamps.locator('..')).toHaveAttribute('open', '');
      await timestamps.scrollIntoViewIfNeeded();
      await expectFocusedControlClearOfNavigation(page, timestamps);
    }
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: `${evidence}/zoom200-${item.name}-390x844-dark.png`,
      // The focused control is deliberately above the fixed navigation; a
      // viewport capture proves the dense phone state is not obscured by it.
      fullPage: false,
    });
    expect(errors).toEqual([]);
  });
}

test.beforeAll(async () => {
  await rm(evidence, { recursive: true, force: true });
});

test('keyboard attention action sends safe payload without disturbing focus', async ({ page }) => {
  const payloads: unknown[] = [];
  const outcomes: unknown[] = [];
  await install(page, 'attentionRequired');
  await page.route('**/api/sessions/session-1/attention/attention-1/resolve', async (route) => {
    payloads.push(route.request().postDataJSON());
    outcomes.push({
      status: 202,
      body: { accepted: true, replayed: false, resolvedAt: '2026-08-20T00:01:00.000Z' },
    });
    await route.fulfill({
      contentType: 'application/json',
      status: 202,
      body: JSON.stringify(outcomes.at(-1)!.body),
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat' }).click();
  const control = page.getByRole('button', { name: 'Enable' });
  await control.focus();
  await expect(control).toBeFocused();
  await page.getByLabel('Optional guidance for the resumed work').fill('Continue after repair.');
  await page.getByRole('button', { name: 'Resume' }).press('Enter');
  await expect
    .poll(() => payloads)
    .toEqual([expect.objectContaining({ action: 'resume', guidance: 'Continue after repair.' })]);
  expect(outcomes).toEqual([
    {
      status: 202,
      body: { accepted: true, replayed: false, resolvedAt: '2026-08-20T00:01:00.000Z' },
    },
  ]);
});

test('keyboard toggle is idempotent and preserves focus through a socket update', async ({
  page,
}) => {
  const payloads: unknown[] = [];
  const idempotencyKeys: string[] = [];
  await install(page, 'monitoring');
  await page.route('**/api/sessions/session-1/autopilot', async (route) => {
    payloads.push(route.request().postDataJSON());
    idempotencyKeys.push(route.request().headers()['idempotency-key'] ?? '');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        autopilot:
          payloads.length === 1 ? autopilot('disabled', 'manualDisabled') : autopilot('monitoring'),
      }),
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat' }).click();
  const control = page.getByRole('button', { name: 'Pause' });
  await control.focus();
  await control.press('Enter');
  await expect.poll(() => payloads.length).toBe(1);
  expect(idempotencyKeys[0]).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  const updatedControl = page.getByRole('button', { name: 'Enable' });
  await expect(updatedControl).toBeFocused();
  await expect(updatedControl).toHaveAttribute('aria-pressed', 'false');
  await updatedControl.press('Enter');
  await expect
    .poll(() => payloads)
    .toEqual([
      expect.objectContaining({ enabled: false }),
      expect.objectContaining({ enabled: true }),
    ]);
  await expect(page.getByRole('button', { name: 'Pause' })).toBeFocused();
});

test('typed missing-plan conflicts remain safe and actionable after the real toggle endpoint response', async ({
  page,
}) => {
  await install(page, 'disabled', 'manualDisabled', false);
  await page.route('**/api/sessions/session-1/autopilot', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'AUTOPILOT_PLAN_REQUIRED',
        detail: 'internal plan path: /secret',
      }),
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat' }).click();
  await page.getByRole('button', { name: 'Enable' }).press('Enter');
  await expect(page.getByRole('region', { name: 'Autopilot' })).toContainText(
    'An incomplete supervised plan is required before Autopilot can start.',
  );
  await expect(page.locator('body')).not.toContainText('/secret');
});

test('safety-stop recovery uses the Autopilot toggle endpoint, never an attention resolver', async ({
  page,
}) => {
  const toggles: unknown[] = [];
  await install(page, 'attentionRequired', 'reconcileFailed', false);
  await page.route('**/api/sessions/session-1/autopilot', async (route) => {
    toggles.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ autopilot: autopilot('monitoring') }),
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat' }).click();
  await page.getByRole('button', { name: 'Retry Autopilot' }).press('Enter');
  await expect.poll(() => toggles).toEqual([expect.objectContaining({ enabled: true })]);
  await expect(page.getByRole('button', { name: 'Pause' })).toBeFocused();
});

test('renders historical resolved attention as audit without resurrecting the alert', async ({
  page,
}) => {
  await install(page, 'monitoring', undefined, false);
  await page.route('**/api/sessions/session-1/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        chatSnapshot({
          autopilotAudit: [
            {
              id: 'resolved-attention',
              label: 'Attention resolved',
              occurredAt: Date.parse('2026-08-20T00:01:00.000Z'),
            },
          ],
        }),
      ),
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat' }).click();
  await expect(page.getByLabel('Autopilot audit entry')).toContainText('Attention resolved');
  await expect(page.getByRole('alert', { name: 'Autopilot needs your attention' })).toHaveCount(0);
});

test('selected Chat receives live autopilot and attention journal events without a duplicate socket', async ({
  page,
}) => {
  let socket: { send(message: string): void } | undefined;
  await install(page, 'disabled', undefined, false, (connection) => (socket = connection));
  const errors = captureBrowserErrors(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat' }).click();
  await expect.poll(() => socket).toBeDefined();
  const control = page.getByRole('button', { name: 'Enable' });
  await control.focus();
  socket!.send(
    JSON.stringify({
      type: 'relay.event',
      event: {
        sequence: 1,
        type: 'autopilot.updated',
        occurredAt: '2026-08-20T00:00:01.000Z',
        payload: autopilot('monitoring'),
      },
    }),
  );
  await expect(page.getByRole('button', { name: 'Pause' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Pause' })).toBeFocused();
  await expect(page.getByTestId('autopilot-live-status')).toHaveText(
    'Autopilot status: Monitoring. Autopilot is monitoring this supervised plan.',
  );
  await expect(page.getByRole('region', { name: 'Autopilot' })).not.toContainText('Retry 0');
  socket!.send(
    JSON.stringify({
      type: 'relay.event',
      event: {
        sequence: 2,
        type: 'org-plan.attention-required',
        occurredAt: '2026-08-20T00:00:02.000Z',
        payload: attention,
      },
    }),
  );
  await expect(page.getByRole('alert', { name: 'Autopilot needs your attention' })).toBeVisible();
  await expect(page.getByLabel('Chat messages')).toContainText('Autopilot needs attention');
  await expect(page.getByText('Autopilot needs your attention.')).toHaveCount(1);
  await expectNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

test('coordinator-derived event fixture, replay gap, and a Sessions-origin toggle converge without synthetic labels', async ({
  page,
}) => {
  let socket: { send(message: string): void } | undefined;
  const toggles: unknown[] = [];
  let refreshes = 0;
  await install(page, 'disabled', undefined, false, (connection) => (socket = connection));
  await page.route('**/api/sessions/session-1/activity/refresh', async (route) => {
    refreshes += 1;
    await route.fulfill({ status: 204 });
  });
  await page.route('**/api/sessions/session-1/autopilot', async (route) => {
    toggles.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ autopilot: autopilot('monitoring') }),
    });
  });
  const errors = captureBrowserErrors(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Sessions' }).click();
  await page.getByLabel('Open sessions').getByRole('button', { name: 'Enable' }).press('Enter');
  await expect.poll(() => toggles).toEqual([expect.objectContaining({ enabled: true })]);
  await page.getByRole('button', { name: 'Chat' }).click();
  await expect.poll(() => socket).toBeDefined();
  for (const event of [
    { sequence: 1, type: 'autopilot.updated', payload: autopilot('monitoring') },
    { sequence: 2, type: 'autopilot.continuation-scheduled', payload: { controlId: 'control-1' } },
    { sequence: 3, type: 'autopilot.control-issued', payload: { controlId: 'control-1' } },
    { sequence: 4, type: 'autopilot.turn-started', payload: { controlId: 'control-1' } },
    { sequence: 5, type: 'autopilot.progress-reset', payload: { reason: 'planUpdated' } },
    {
      sequence: 6,
      type: 'autopilot.turn-failed',
      payload: { controlId: 'control-1', code: 'START_FAILED' },
    },
    // Deliberately skip 7: activity reconciliation owns this single refresh.
    { sequence: 8, type: 'autopilot.updated', payload: autopilot('backoff') },
    { sequence: 9, type: 'autopilot.updated', payload: autopilot('completed', 'planComplete') },
  ])
    socket!.send(
      JSON.stringify({
        type: 'relay.event',
        event: { ...event, occurredAt: '2026-08-20T00:00:01.000Z' },
      }),
    );
  await expect(page.getByRole('region', { name: 'Autopilot' })).toContainText('Complete');
  await expect(page.getByLabel('Chat messages')).toContainText('Autopilot continuation started');
  await expect(page.getByLabel('Chat messages')).toContainText(
    'Autopilot reset retry progress after the plan changed',
  );
  await expect(page.getByLabel('Chat messages')).toContainText('Autopilot continuation failed');
  await expect.poll(() => refreshes).toBe(1);
  await expectNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
});
