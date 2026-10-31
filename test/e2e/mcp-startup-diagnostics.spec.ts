/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { ChatRelayFixture } from './chat-relay-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { McpStartupTracker } from '../../src/server/platform/codex/mcp-startup-failure.js';
import { normalizeCodexNotification } from '../../src/server/platform/codex/normalizer.js';

for (const width of [390, 1440]) {
  for (const fontScale of [100, 200]) {
    test(`MCP health stays out of chat and failures notify at ${width}px font${fontScale}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await mockAuthenticatedStatus(page);
      const fixture = new ChatRelayFixture(page);
      const session = {
        id: 'startup-session',
        state: 'ready',
        threadId: 'root',
        provider: 'codex',
        workspaceId: 'workspace',
        workspacePath: '/workspace',
        profile: 'default',
        activeTurnId: null,
      };
      await fixture.install([session]);
      const tracker = new McpStartupTracker();
      let sequence = 0;
      const event = (status: string, name = 'context-mode') => {
        const observed = tracker.observe({
          method: 'mcpServer/startupStatus/updated',
          params: { status, name, error: 'private-secret TOKEN=secret' },
        })!;
        return normalizeCodexNotification(session.id, ++sequence, observed.observedAt, {
          method: 'gestalt/mcpStartup',
          params: observed,
        })!;
      };
      const ready = ['context-mode', 'gestalt-context-mode', 'gestalt-serena', 'gestalt-xerj'].map(
        (name) => event('ready', name),
      );
      sequence = 0;
      fixture.snapshot(
        session.id,
        chatSnapshot({ activities: ready.map(({ payload }) => payload) }),
      );
      await page.goto('/');
      await page.getByRole('button', { name: 'Chat', exact: true }).click();
      await expect.poll(() => fixture.sockets.has(session.id)).toBe(true);
      await page.locator('html').evaluate((element, scale) => {
        element.style.fontSize = `${scale}%`;
      }, fontScale);
      const timeline = page.getByRole('list', { name: 'Chat messages' });
      await expect(timeline.locator(':scope > li')).toHaveCount(0);
      const send = (status: string, name = 'context-mode') => {
        const update = event(status, name);
        fixture.event(session.id, update.sequence, update.type, update.payload, update.occurredAt);
        return update;
      };
      for (const name of [
        'context-mode',
        'gestalt-context-mode',
        'gestalt-serena',
        'gestalt-xerj',
      ]) {
        send('starting', name);
        send('ready', name);
      }
      // A subsequent visible activity confirms that all earlier service events were consumed.
      fixture.event(session.id, ++sequence, 'activity.updated', {
        id: 'command',
        label: 'Command · completed',
        detail: 'git status --short',
      });
      await expect(timeline).toContainText('Work details · 1 activity');
      await page.getByText('Work details · 1 activity').click();
      await expect(timeline).toContainText('Successful commands');
      await expect(timeline).not.toContainText('Serena');
      await expect(page.getByRole('status').filter({ hasText: /startup/ })).toHaveCount(0);
      const optional = send('failed', 'gestalt-serena');
      const legacy = normalizeCodexNotification(session.id, ++sequence, optional.occurredAt, {
        method: 'mcpServer/statusUpdated',
        params: { name: 'gestalt-serena', status: 'failed' },
      })!;
      fixture.event(session.id, legacy.sequence, legacy.type, legacy.payload, legacy.occurredAt);
      const warning = page.getByRole('status').filter({ hasText: 'Serena startup failed.' });
      await expect(warning).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: 'Serena' })).toHaveCount(1);
      await expect(timeline).not.toContainText('Serena');
      await warning.getByRole('button', { name: 'Dismiss warning notification' }).click();
      const required = send('failed');
      const requiredWarning = page
        .getByRole('status')
        .filter({ hasText: 'Context Mode startup failed.' });
      await expect(requiredWarning).toBeVisible();
      await expect(requiredWarning).toContainText('Required tool unavailable.');
      await expect(timeline).not.toContainText('Context Mode');
      await expect(page.locator('body')).not.toContainText('private-secret');
      await page.screenshot({ path: testInfo.outputPath('startup-warning.png') });
      send('ready');
      await expect(requiredWarning).toHaveCount(0);
      await expect(timeline.locator(':scope > li')).toHaveCount(1);
      await page.getByRole('button', { name: 'Open configuration' }).click();
      await page.getByRole('button', { name: 'Notifications', exact: true }).click();
      const history = page.getByRole('list', { name: 'Recent notifications' });
      await expect(history.locator(':scope > li')).toHaveCount(2);
      const startup = (required.payload as { mcpStartup: { failure: { failureId: string } } })
        .mcpStartup;
      await expect(history).toContainText(startup.failure.failureId);
      expect(fixture.commands).toEqual([]);
    });
  }
}
