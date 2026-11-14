/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Locator } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';
import { screenshotPath } from './screenshot-path.js';
import { ChatRelayFixture } from './chat-relay-fixture.js';
import { unknownReadiness } from '../../src/shared/contracts/retrieval-readiness.js';

// Deliberately retain retired extra fields to exercise old persisted payload hydration.
const saved = {
  id: 'retirement-saved',
  state: 'released',
  threadId: 'retirement-thread',
  workspacePath: '/projects/retained-session',
  workspaceId: 'workspace-1',
  profile: 'work',
  provider: 'codex',
  activeTurnId: null,
  xerj: { state: 'ready', root: '/projects' },
};

async function visibleControlBounds(control: Locator) {
  await expect(control).toBeInViewport({ ratio: 1 });
  const bounds = await control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const panel = element.closest('#configuration-panel')!.getBoundingClientRect();
    return {
      top: box.top,
      bottom: box.bottom,
      left: box.left,
      right: box.right,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      panelTop: panel.top,
      panelBottom: panel.bottom,
    };
  });
  expect(bounds.top).toBeGreaterThanOrEqual(Math.max(0, bounds.panelTop));
  expect(bounds.bottom).toBeLessThanOrEqual(Math.min(bounds.viewportHeight, bounds.panelBottom));
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
  return bounds;
}

for (const settings of [
  { width: 320, height: 568, fontPercent: 100 },
  { width: 768, height: 1024, fontPercent: 200 },
]) {
  test(`retirement visual evidence ${settings.width}x${settings.height} at ${settings.fontPercent}%`, async ({
    page,
  }) => {
    const evidence = process.env.PLAYWRIGHT_EVIDENCE_DIR;
    if (!evidence) throw new Error('PLAYWRIGHT_EVIDENCE_DIR must identify persistent evidence');
    await mkdir(evidence, { recursive: true });
    const prefix = `${settings.width}x${settings.height}-${settings.fontPercent}`;
    const network: Array<{ method: string; path: string; status: number; contentType: string }> =
      [];
    const unmatched: Array<{ method: string; path: string }> = [];
    const controlMetrics: Record<string, unknown> = {};
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith('/api/'))
        network.push({
          method: response.request().method(),
          path,
          status: response.status(),
          contentType: response.headers()['content-type'] ?? '',
        });
    });
    await page.route('**/api/**', (route) => {
      unmatched.push({
        method: route.request().method(),
        path: new URL(route.request().url()).pathname,
      });
      return route.fulfill({ status: 404, json: { code: 'UNMOCKED_FIXTURE_ENDPOINT' } });
    });
    await page.setViewportSize(settings);
    await page.addInitScript((percent) => {
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.style.fontSize = `${percent}%`;
      });
    }, settings.fontPercent);
    await mockAuthenticatedStatus(page);
    const fixture = new ChatRelayFixture(page);
    await fixture.install([saved]);
    fixture.snapshot(
      saved.id,
      chatSnapshot({
        items: [
          {
            id: 'saved-answer',
            kind: 'agent',
            text: 'Saved conversation remains readable.',
            phase: 'final_answer',
          },
        ],
        activities: [
          {
            id: 'old-startup',
            label: 'XERJ startup',
            detail: 'Old status',
            mcpStartup: { serverName: 'gestalt-xerj' },
          },
        ] as unknown as NonNullable<Parameters<typeof chatSnapshot>[0]>['activities'],
      }),
    );
    const created = {
      ...saved,
      id: 'retirement-created',
      threadId: 'fresh-thread',
      state: 'ready',
      workspacePath: '/projects/new-session',
    };
    let createRequests = 0;
    let skillProfilesRead = false;
    await page.route('**/api/skill-profiles', (route) => {
      skillProfilesRead = true;
      return route.fulfill({ json: { profiles: [] } });
    });
    await page.route('**/api/bootstrap', (route) =>
      route.fulfill({
        json: {
          workspaces: [
            {
              id: 'workspace-1',
              name: 'project',
              relativePath: '.',
              isGitRepository: false,
              children: [],
            },
          ],
          profiles: [{ name: 'work', state: 'ok', status: 'ready' }],
          sessions: fixture.sessions,
          xerj: { state: 'error', root: '/projects', message: 'XERJ needs an index rebuild.' },
          versions: [
            { id: 'xerj', label: 'XERJ', version: 'old' },
            { id: 'serena', label: 'Serena', version: 'fixture', status: 'ready' },
          ],
        },
      }),
    );
    await page.route('**/api/sessions/recent-threads', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/sessions', (route) => {
      if (route.request().method() === 'POST') {
        createRequests++;
        expect(route.request().postDataJSON()).not.toHaveProperty('xerj');
        fixture.sessions.push(created);
        fixture.snapshot(created.id, chatSnapshot());
        return route.fulfill({ json: created });
      }
      return route.fulfill({ json: fixture.sessions });
    });
    await page.route('**/api/sessions/*/plan', (route) => route.fulfill({ status: 404 }));
    await page.route('**/api/sessions/retirement-saved', (route) => route.fulfill({ json: saved }));
    await page.route('**/api/sessions/retirement-created', (route) =>
      route.fulfill({ json: created }),
    );
    await page.route('**/api/sessions/*/activity/refresh', (route) =>
      route.fulfill({ status: 204 }),
    );
    let restoreRequests = 0;
    await page.route('**/api/sessions/retirement-saved/restore', (route) => {
      restoreRequests += 1;
      return route.fulfill({ status: 500 });
    });
    const readiness = unknownReadiness();
    readiness.connection.state = 'ready';
    readiness.repository = { id: 'a'.repeat(64), label: 'retained-project' };
    readiness.symbols.state = 'ready';
    readiness.references.state = 'ready';
    let readinessUnavailable = false;
    await page.route('**/api/sessions/*/retrieval-readiness', (route) =>
      route.fulfill(
        readinessUnavailable
          ? { status: 503, json: { code: 'READINESS_UNAVAILABLE' } }
          : {
              json: {
                connections: [
                  { serverName: 'gestalt-serena', readiness },
                  { serverName: 'gestalt-xerj', readiness },
                ],
                repositories: [{ threadId: 'retained-child', readiness }],
              },
            },
      ),
    );
    try {
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Create session' })).toBeVisible();
      await expect.poll(() => skillProfilesRead).toBe(true);
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByText(/Unexpected token|not valid JSON/)).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(/XERJ|Xerj|Workspace discovery/);
      await page.screenshot({ path: screenshotPath(`${prefix}-fresh.png`), fullPage: true });
      await page.getByRole('button', { name: 'Create session' }).click();
      await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeEnabled();
      expect(createRequests).toBe(1);
      await page.screenshot({ path: screenshotPath(`${prefix}-fresh-chat.png`), fullPage: true });
      await page.getByRole('button', { name: 'Open configuration' }).click();
      const tools = page.getByRole('region', { name: 'Repository tools' });
      await tools.locator('summary').click();
      await expect(tools.locator('summary')).toHaveAccessibleName(
        'Repository tool readiness: Ready on observed source',
      );
      await expect(tools).toContainText('Serena connection');
      await expect(tools).not.toContainText('XERJ');
      await tools.scrollIntoViewIfNeeded();
      await tools.screenshot({ path: screenshotPath(`${prefix}-retained-diagnostics.png`) });
      readinessUnavailable = true;
      await tools.getByRole('button', { name: 'Refresh tool readiness' }).click();
      await page.keyboard.press('Escape');
      const warning = page
        .getByRole('status')
        .filter({ hasText: 'Could not refresh tool readiness.' });
      await expect(warning).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeEnabled();
      await page.screenshot({
        path: screenshotPath(`${prefix}-retained-feedback.png`),
        fullPage: true,
      });
      await warning.getByRole('button', { name: 'Dismiss warning notification' }).click();
      readinessUnavailable = false;
      await page.getByRole('button', { name: 'Sessions', exact: true }).click();
      await page.screenshot({ path: screenshotPath(`${prefix}-sessions.png`), fullPage: true });
      await page
        .getByLabel('Saved sessions')
        .getByRole('button', { name: 'Open', exact: true })
        .click();
      await expect(page.getByRole('button', { name: 'Chat', pressed: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
      await expect(page.getByText('Saved conversation remains readable.')).toBeVisible();
      await expect(page.locator('body')).not.toContainText(/XERJ|Xerj|Workspace discovery/);
      expect(restoreRequests).toBe(0);
      await page.screenshot({ path: screenshotPath(`${prefix}-chat.png`), fullPage: true });
      await page.getByRole('button', { name: 'Open configuration' }).click();
      const panel = page.locator('#configuration-panel');
      await panel.evaluate((element) => {
        element.scrollTop = 0;
      });
      controlMetrics.appearance = await visibleControlBounds(
        panel.getByRole('combobox', { name: 'Appearance' }),
      );
      await page.screenshot({ path: screenshotPath(`${prefix}-header.png`), fullPage: true });
      await expect(page.getByRole('region', { name: 'Workspace discovery' })).toHaveCount(0);
      await expect(page.locator('#configuration-panel')).not.toContainText(/XERJ|Xerj|Indexer/);
      const quit = panel.getByRole('button', { name: 'Quit', exact: true });
      await quit.scrollIntoViewIfNeeded();
      await quit.focus();
      await expect(quit).toBeFocused();
      for (const name of ['Clean TMP', 'Upgrade', 'Quit'])
        controlMetrics[name] = await visibleControlBounds(
          panel.getByRole('button', { name, exact: true }),
        );
      await page.screenshot({
        path: screenshotPath(`${prefix}-retained-controls.png`),
        fullPage: true,
      });
      await page.keyboard.press('Escape');
      await page.goto('/?chat-session=retirement-saved');
      await expect(page.getByText('Saved conversation remains readable.')).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
      expect(restoreRequests).toBe(0);
      await page.screenshot({
        path: screenshotPath(`${prefix}-detached-history.png`),
        fullPage: true,
      });
      await page.goto('/');
      await page.getByRole('button', { name: 'Chat', exact: true }).click();
      await expect(page.getByText('Saved conversation remains readable.')).toBeVisible();
      fixture.lockWriter(saved.id);
      const prompt = page.getByRole('textbox', { name: 'Prompt' });
      await prompt.fill('Inspect retained session');
      await page.getByRole('button', { name: 'Send prompt' }).click();
      await expect(page.getByRole('region', { name: 'Chat' }).getByRole('alert')).toContainText(
        'active in another Codex client',
      );
      await expect(page.getByRole('button', { name: 'Dismiss error notification' })).toBeVisible();
      await page.screenshot({ path: screenshotPath(`${prefix}-send-retry.png`), fullPage: true });
      await page.getByRole('button', { name: 'Dismiss error notification' }).click();
      fixture.releaseWriter(saved.id);
      const turn = fixture.deferTurn(saved.id);
      await page.getByRole('button', { name: 'Retry send' }).click();
      turn.resolve({ kind: 'fulfill', status: 200, body: { activeTurnId: 'accepted-turn' } });
      await expect(page.getByRole('button', { name: 'Choose prompt action' })).toBeVisible();
      expect(fixture.commands).toHaveLength(2);
      expect(fixture.commands[1]?.idempotencyKey).toBe(fixture.commands[0]?.idempotencyKey);
      expect(restoreRequests).toBe(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
      await page.screenshot({
        path: screenshotPath(`${prefix}-send-accepted.png`),
        fullPage: true,
      });
      const actual = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        rootFontSize: getComputedStyle(document.documentElement).fontSize,
        fontSetting: document.documentElement.style.fontSize,
        devicePixelRatio: window.devicePixelRatio,
      }));
      expect(actual.width).toBe(settings.width);
      expect(actual.height).toBe(settings.height);
      expect(actual.fontSetting).toBe(`${settings.fontPercent}%`);
      expect(actual.rootFontSize).toBe(`${settings.fontPercent === 100 ? 16 : 32}px`);
      expect(unmatched).toEqual([]);
      expect(network.filter((entry) => entry.contentType.includes('text/html'))).toEqual([]);
      expect(network.filter((entry) => entry.path === '/api/xerj')).toEqual([]);
      await expect(page.locator('body')).not.toContainText(/XERJ|Xerj|Workspace discovery/);
      await expect(page.getByRole('alert')).toHaveCount(0);
    } finally {
      const actual = await page
        .evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          rootFontSize: getComputedStyle(document.documentElement).fontSize,
          fontSetting: document.documentElement.style.fontSize,
          devicePixelRatio,
        }))
        .catch(() => null);
      await writeFile(
        join(evidence, `${prefix}-settings.json`),
        JSON.stringify(
          { settings, actual, controlMetrics, observedAt: new Date().toISOString() },
          null,
          2,
        ),
      );
      await writeFile(
        join(evidence, `${prefix}-network.json`),
        JSON.stringify(
          {
            network,
            unmatched,
            createRequests,
            restoreRequests,
            sendRequests: fixture.commands.length,
            stableRetryKey:
              fixture.commands.length === 2 &&
              Boolean(fixture.commands[0]?.idempotencyKey) &&
              fixture.commands[0]?.idempotencyKey === fixture.commands[1]?.idempotencyKey,
          },
          null,
          2,
        ),
      );
    }
  });
}
