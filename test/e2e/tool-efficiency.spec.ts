/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { ChatRelayFixture } from './chat-relay-fixture.js';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { efficiencyFixture } from '../../src/shared/contracts/tool-efficiency.test-fixture.js';

const evidence = process.env.EFFICIENCY_EVIDENCE_DIR ?? '/tmp/mobile-efficiency-browser';
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  for (const scale of [100, 200]) {
    for (const theme of ['minimal-light', 'minimal-dark']) {
      test(`tool efficiency has accessible scopes and no overflow ${viewport.width}px font${scale} ${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await page.addInitScript(
          (value) => localStorage.setItem('gestalt-mobile.theme', value),
          theme,
        );
        await mockAuthenticatedStatus(page);
        const fixture = new ChatRelayFixture(page);
        const session = {
          id: 'efficiency-session',
          state: 'ready',
          threadId: 'root',
          provider: 'codex',
          workspaceId: 'workspace',
          workspacePath: '/synthetic/workspace',
          profile: 'default',
          activeTurnId: null,
        };
        const snapshot = efficiencyFixture(session.id);
        await fixture.install([session]);
        await page.route('**/api/sessions/*/plan', (route) => route.fulfill({ status: 204 }));
        await page.route('**/api/sessions/efficiency-session', (route) =>
          route.fulfill({ json: { ...session, currentSequence: 0, toolEfficiency: snapshot } }),
        );
        await page.goto('/');
        await page.getByRole('button', { name: 'Chat', exact: true }).click();
        await page.locator('html').evaluate((element, value) => {
          element.style.fontSize = `${value}%`;
        }, scale);
        const section = page.getByRole('region', { name: 'Tool efficiency', exact: true });
        const summary = section.locator('summary').first();
        await expect(summary).toContainText('Partial coverage');
        await summary.focus();
        await expect(summary).toBeFocused();
        await page.keyboard.press('Enter');
        const observations = section.getByRole('region', { name: 'Tool efficiency observations' });
        await expect(observations).toBeVisible();
        await expect(section.getByText('0 ms', { exact: true })).toBeVisible();
        await expect(section.getByText('0 B', { exact: true })).toBeVisible();
        await expect(section).toContainText(
          'Child (child-thread-with-a-long-opaque-identity) · Context-mode',
        );
        await expect(section).toContainText('Wrapper scope');
        await expect(section).toContainText('1 of 2 calls measured · partial');
        await expect(section).toContainText('Some events could not be attributed');
        await expect(section).toContainText('Observation retention is limited');
        await page.keyboard.press('Tab');
        await expect(observations).toBeFocused();
        const initialScroll = await observations.evaluate((element) => element.scrollTop);
        await page.keyboard.press('PageDown');
        await expect
          .poll(() => observations.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(initialScroll);
        const quality = section.locator('.quality summary').last();
        await quality.focus();
        await page.keyboard.press('Enter');
        await expect(quality.locator('..')).toHaveAttribute('open', '');
        await expect(quality.locator('..')).toContainText('Retries');
        await expect(quality.locator('..')).toContainText('Reused calls');
        await expect(quality.locator('..')).toContainText('Unknown');
        await expect(quality.locator('..')).toContainText('1 partial');
        await observations.evaluate((element) => {
          element.scrollTop = 0;
        });
        const metrics = await section.evaluate((element) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d')!;
          const rgb = (color: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data];
          };
          const luminance = (values: number[]) =>
            values
              .slice(0, 3)
              .map((value) => {
                const s = value / 255;
                return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
              })
              .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
          const targets = [
            ...element.querySelectorAll('p,dt,dd,small,h3,summary,summary > span'),
          ].filter((target) => (target as HTMLElement).checkVisibility());
          const ratios = targets.map((target) => {
            let background = [255, 255, 255, 255];
            for (let parent: Element | null = target; parent; parent = parent.parentElement) {
              const candidate = rgb(getComputedStyle(parent).backgroundColor);
              if (candidate[3] === 255) {
                background = candidate;
                break;
              }
            }
            const a = luminance(rgb(getComputedStyle(target).color)),
              b = luminance(background);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          });
          const region = element.querySelector('.observations') as HTMLElement;
          return {
            minimumContrast: Math.min(...ratios),
            rootFontSize: getComputedStyle(document.documentElement).fontSize,
            documentOverflow: document.documentElement.scrollWidth > window.innerWidth,
            sectionClientWidth: element.clientWidth,
            sectionScrollWidth: element.scrollWidth,
            regionClientWidth: region.clientWidth,
            regionScrollWidth: region.scrollWidth,
            summaryHeight: element.querySelector('summary')!.getBoundingClientRect().height,
            allFieldsFit: [...element.querySelectorAll('dt,dd,h3')].every(
              (field) => field.scrollWidth <= field.clientWidth,
            ),
            focusOutlineStyle: getComputedStyle(region).outlineStyle,
          };
        });
        expect(metrics.minimumContrast).toBeGreaterThanOrEqual(4.5);
        expect(metrics.rootFontSize).toBe(`${(16 * scale) / 100}px`);
        expect(metrics.documentOverflow).toBe(false);
        expect(metrics.sectionScrollWidth).toBeLessThanOrEqual(metrics.sectionClientWidth);
        expect(metrics.regionScrollWidth).toBeLessThanOrEqual(metrics.regionClientWidth);
        expect(metrics.allFieldsFit).toBe(true);
        expect(metrics.summaryHeight).toBeGreaterThanOrEqual(44);
        await mkdir(evidence, { recursive: true });
        const label = `${viewport.width}-font${scale}-${theme}`;
        await writeFile(`${evidence}/metrics-${label}.json`, JSON.stringify(metrics, null, 2));
        await summary.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${evidence}/efficiency-${label}.png` });
        await quality.scrollIntoViewIfNeeded();
        await quality.focus();
        await page.screenshot({ path: `${evidence}/efficiency-counters-${label}.png` });
      });
    }
  }
}

test('efficiency replay, reconnect and session switching preserve only the latest owning snapshot', async ({
  page,
}) => {
  await mockAuthenticatedStatus(page);
  const fixture = new ChatRelayFixture(page);
  const session = {
    id: 'efficiency-session',
    state: 'ready',
    threadId: 'root',
    provider: 'codex',
    workspacePath: '/synthetic/workspace',
    profile: 'default',
    activeTurnId: null,
  };
  const snapshot = efficiencyFixture(session.id);
  let current = snapshot;
  let sequence = 0;
  const empty = {
    ...session,
    id: 'empty-session',
    threadId: 'empty-root',
    workspacePath: '/synthetic/empty',
  };
  await fixture.install([session, empty]);
  await page.route('**/api/sessions/*/plan', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/sessions/empty-session', (route) =>
    route.fulfill({
      json: {
        ...empty,
        currentSequence: 0,
        toolEfficiency: {
          sessionId: empty.id,
          revision: 0,
          observedAt: null,
          scope: 'observedCallsOnly',
          coverage: 'unknown',
          missingCorrelation: false,
          retentionLimited: false,
          groups: [],
        },
      },
    }),
  );
  await page.route('**/api/sessions/efficiency-session', (route) =>
    route.fulfill({ json: { ...session, currentSequence: sequence, toolEfficiency: current } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect.poll(() => fixture.sockets.has(session.id)).toBe(true);
  const section = page.getByRole('region', { name: 'Tool efficiency', exact: true });
  await section.locator('summary').first().click();
  await expect(section.getByText('0 ms', { exact: true })).toBeVisible();
  const changed = {
    ...snapshot,
    revision: 2,
    groups: snapshot.groups.map((group, index) =>
      index === 0 ? { ...group, durationMs: { ...group.durationMs, value: 73 } } : group,
    ),
  };
  fixture.duplicate(session.id, 1, 'tool.efficiency.updated', changed);
  await expect(section.getByText('73 ms', { exact: true })).toBeVisible();
  fixture.event(session.id, 2, 'tool.efficiency.updated', snapshot);
  fixture.event(session.id, 3, 'tool.efficiency.updated', efficiencyFixture('other', 999));
  await expect(section.getByText('73 ms', { exact: true })).toBeVisible();
  current = changed;
  sequence = 3;
  fixture.close(session.id);
  await expect.poll(() => fixture.socketGroups.get(session.id)?.size ?? 0).toBeGreaterThan(1);
  await expect(section.getByText('73 ms', { exact: true })).toBeVisible();
  // A full reload hydrates from the replacement snapshot, rather than adding replay totals.
  await page.reload();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page
    .getByRole('region', { name: 'Tool efficiency', exact: true })
    .locator('summary')
    .first()
    .click();
  await expect(page.getByText('73 ms', { exact: true })).toBeVisible();
  expect(await section.textContent()).not.toMatch(/score|quota|saved|violation/i);
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page
    .locator('.managed-session')
    .filter({ hasText: '/synthetic/empty' })
    .getByRole('button', { name: 'Open', exact: true })
    .click();
  const emptySection = page.getByRole('region', { name: 'Tool efficiency', exact: true });
  await emptySection.locator('summary').first().click();
  await expect(emptySection).toContainText('No measured tool calls yet');
  fixture.event(session.id, 4, 'tool.efficiency.updated', { ...changed, revision: 99 });
  await expect(emptySection).not.toContainText('73 ms');
  await expect(emptySection).toContainText('No measurements yet');
});
