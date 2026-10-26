/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { ChatRelayFixture } from './chat-relay-fixture.js';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { McpStartupTracker } from '../../src/server/platform/codex/mcp-startup-failure.js';
import { normalizeCodexNotification } from '../../src/server/platform/codex/normalizer.js';

const evidence = process.env.STARTUP_EVIDENCE_DIR ?? '/tmp/mobile-startup-browser';
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  for (const fontScale of [100, 200]) {
    test(`bounded MCP failure, fallback and recovery ${viewport.width}px font${fontScale}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await mockAuthenticatedStatus(page);
      const fixture = new ChatRelayFixture(page);
      const session = {
        id: 'startup-session',
        state: 'ready',
        threadId: 'root',
        provider: 'codex',
        workspaceId: 'workspace',
        workspacePath: '/private/workspace',
        profile: 'default',
        activeTurnId: null,
      };
      await fixture.install([session]);
      await page.route('**/api/skill-profiles', (route) =>
        route.fulfill({ json: { profiles: [] } }),
      );
      await page.route('**/api/sessions/*/plan', (route) => route.fulfill({ status: 204 }));
      const mutations: string[] = [];
      page.on('request', (request) => {
        if (request.method() !== 'GET') mutations.push(request.url());
      });
      await page.goto('/');
      await page.getByRole('button', { name: 'Chat', exact: true }).click();
      await expect.poll(() => fixture.sockets.has(session.id)).toBe(true);
      await page.locator('html').evaluate((element, scale) => {
        element.style.fontSize = `${scale}%`;
      }, fontScale);
      const tracker = new McpStartupTracker();
      let sequence = 0;
      const send = (
        status: string,
        name = 'context-mode',
        threadId: string | null = 'child-'.padEnd(128, 'x'),
      ) => {
        const observed = tracker.observe({
          method: 'mcpServer/startupStatus/updated',
          params: {
            status,
            name,
            threadId,
            error: 'private-secret TOKEN=secret stderr prompt output',
            exitCode: 23,
            signal: 'SIGKILL',
          },
        })!;
        const event = normalizeCodexNotification(session.id, ++sequence, observed.observedAt, {
          method: 'gestalt/mcpStartup',
          params: observed,
        })!;
        fixture.event(session.id, sequence, event.type, event.payload, event.occurredAt);
        return observed;
      };
      const optional = send('failed', 'gestalt-serena', null);
      const legacy = normalizeCodexNotification(session.id, ++sequence, optional.observedAt, {
        method: 'mcpServer/statusUpdated',
        params: { name: 'gestalt-serena', status: 'failed' },
      })!;
      fixture.event(session.id, sequence, legacy.type, legacy.payload, legacy.occurredAt);
      const warning = page.getByRole('status').filter({ hasText: 'Serena startup failed.' });
      await expect(warning).toBeVisible();
      await expect(warning).toContainText('Continue with native code tools.');
      await expect(page.getByRole('status').filter({ hasText: 'Serena' })).toHaveCount(1);
      await page.getByText(/^Work details/).click();
      const optionalRegion = page.getByRole('region', { name: 'Serena startup' });
      await expect(optionalRegion).toContainText('Observed phase');
      await expect(optionalRegion).toContainText(
        'Codex did not expose child exit or signal details.',
      );
      await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeEnabled();
      await mkdir(evidence, { recursive: true });
      const suffix = `${viewport.width}-font${fontScale}`;
      await optionalRegion.screenshot({ path: `${evidence}/optional-${suffix}.png` });
      await warning.getByRole('button', { name: 'Dismiss warning notification' }).click();
      const required = send('failed');
      const error = page.getByRole('alert').filter({ hasText: 'Context Mode startup failed.' });
      await expect(error).toBeVisible();
      await expect(error).toContainText('Required tool unavailable.');
      const region = page.getByRole('region', { name: 'Context Mode startup' });
      await expect(region).toContainText('No underlying cause is established.');
      await expect(region).toContainText('The affected startup cannot continue');
      await error.screenshot({ path: `${evidence}/toast-${suffix}.png` });
      await error.focus();
      await error.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(error).toContainText(required.failure!.failureId);
      await error.screenshot({ path: `${evidence}/toast-end-${suffix}.png` });
      await region
        .locator('p')
        .first()
        .evaluate((element) => {
          element.style.scrollMarginTop = `${(document.querySelector('header')?.getBoundingClientRect().height ?? 120) + 16}px`;
          element.scrollIntoView({ block: 'start', behavior: 'instant' });
        });
      await page.screenshot({ path: `${evidence}/required-${suffix}.png` });
      const reference = region.locator('summary');
      await reference.focus();
      await expect(reference).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(region.locator('details')).toHaveAttribute('open', '');
      await expect(region.getByText(required.failure!.failureId, { exact: true })).toBeVisible();
      const metrics = await region.evaluate((element) => {
        const luminance = (color: string) => {
          const values = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((value) => {
              const channel = value / 255;
              return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            });
          return values.reduce(
            (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
            0,
          );
        };
        const ratios = [...element.querySelectorAll('p,dt,dd,summary')].map((node) => {
          let parent: Element | null = node;
          while (
            parent &&
            ['rgba(0, 0, 0, 0)', 'transparent'].includes(getComputedStyle(parent).backgroundColor)
          )
            parent = parent.parentElement;
          const background = luminance(
            parent ? getComputedStyle(parent).backgroundColor : 'rgb(255, 255, 255)',
          );
          const foreground = luminance(getComputedStyle(node).color);
          return (
            (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05)
          );
        });
        return {
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          fontSize: getComputedStyle(element).fontSize,
          rootFontSize: getComputedStyle(document.documentElement).fontSize,
          minimumContrast: Math.min(...ratios),
          paragraphsWrap: [...element.querySelectorAll('p,dd')].every(
            (node) => node.scrollWidth <= node.clientWidth,
          ),
        };
      });
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
      expect(metrics.paragraphsWrap).toBe(true);
      expect(metrics.fontSize).toBe(`${(16 * fontScale) / 100}px`);
      expect(metrics.minimumContrast).toBeGreaterThanOrEqual(4.5);
      const last = region.locator('dd').last();
      await last.evaluate((element) => {
        for (let parent = element.parentElement; parent; parent = parent.parentElement)
          if (
            parent.scrollHeight > parent.clientHeight &&
            /auto|scroll/.test(getComputedStyle(parent).overflowY)
          )
            parent.scrollTo({ top: parent.scrollHeight, behavior: 'instant' });
        element.scrollIntoView({ block: 'end', behavior: 'instant' });
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
      });
      const endVisible = await last.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const nav = document.querySelector('nav')?.getBoundingClientRect();
        return bounds.top >= 0 && bounds.bottom <= Math.min(innerHeight, nav?.top ?? innerHeight);
      });
      expect(endVisible).toBe(true);
      await page.screenshot({ path: `${evidence}/required-end-${suffix}.png` });
      await writeFile(`${evidence}/required-${suffix}.aria.txt`, await region.ariaSnapshot());
      await writeFile(`${evidence}/metrics-${suffix}.json`, JSON.stringify(metrics, null, 2));
      await expect(page.locator('body')).not.toContainText('private-secret');
      send('ready');
      await expect(error).toHaveCount(0);
      await expect(region).toContainText(
        'Any earlier startup failures remain in the session trace and notification history.',
      );
      await expect(region).not.toContainText('Required tool unavailable.');
      await expect(optionalRegion).toContainText('Optional tool unavailable.');
      await region.screenshot({ path: `${evidence}/recovery-${suffix}.png` });
      expect(fixture.commands).toEqual([]);
      expect(mutations.filter((url) => /repair|restart|install|autopilot/.test(url))).toEqual([]);
      await page.getByRole('button', { name: 'Open configuration' }).click();
      await page.getByRole('button', { name: 'Notifications', exact: true }).click();
      const history = page.getByRole('list', { name: 'Recent notifications' });
      await expect(history).toContainText(required.failure!.failureId);
      await expect(history).toContainText(optional.failure!.failureId);
    });
  }
}
