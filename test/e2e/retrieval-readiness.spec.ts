/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { ChatRelayFixture } from './chat-relay-fixture.js';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { normalizeCodexNotification } from '../../src/server/platform/codex/normalizer.js';
import {
  unknownReadiness,
  type ReadinessState,
  type SessionRetrievalReadiness,
} from '../../src/shared/contracts/retrieval-readiness.js';

const evidence = process.env.READINESS_EVIDENCE_DIR ?? '/tmp/mobile-readiness-browser';
function observed(state: ReadinessState = 'unknown'): SessionRetrievalReadiness {
  const readiness = unknownReadiness();
  readiness.repository = {
    id: 'a'.repeat(64),
    label: 'fork-with-a-long-repository-name-'.repeat(3),
  };
  readiness.connection = {
    state: 'ready',
    observedAt: '2026-10-26T12:00:00Z',
    generation: 'generation',
  };
  readiness.symbols = {
    state: 'ready',
    observedAt: '2026-10-26T12:00:00Z',
    generation: 'generation',
    scope: 'source',
  };
  readiness.references = { ...readiness.symbols, state };
  return {
    runtimeId: 'fixture-runtime',
    observedAt: '2026-10-26T12:00:00Z',
    connections: [{ serverName: 'gestalt-serena', readiness }],
    repositories: [{ threadId: 'child-runtime', readiness }],
  };
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  for (const fontScale of [100, 200]) {
    test(`repository readiness transitions, reconnect and overflow ${viewport.width}px font${fontScale}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await mockAuthenticatedStatus(page);
      const fixture = new ChatRelayFixture(page);
      const session = {
        id: 'readiness-session',
        state: 'ready',
        threadId: 'root-thread',
        provider: 'codex',
        workspaceId: 'workspace',
        workspacePath: '/private/workspace',
        profile: 'default',
        activeTurnId: null,
      };
      await fixture.install([session]);
      const index = unknownReadiness();
      index.connection = {
        state: 'ready',
        observedAt: '2026-10-26T12:00:00Z',
        generation: 'generation',
      };
      index.coverage = {
        state: 'unavailable',
        reason: 'empty-index',
        observedAt: '2026-10-26T12:00:00Z',
        generation: 'generation',
      };
      const xerj = {
        mode: 'auto',
        state: 'watching',
        root: '/private/workspace',
        files: 0,
        records: 0,
        readiness: index,
      };
      await page.route('**/api/bootstrap', (route) =>
        route.fulfill({ json: { workspaces: [], profiles: [], sessions: [session], xerj } }),
      );
      await page.route('**/api/xerj', (route) => route.fulfill({ json: xerj }));
      await page.route('**/api/skill-profiles', (route) =>
        route.fulfill({ json: { profiles: [] } }),
      );
      await page.route('**/api/sessions/*/plan', (route) => route.fulfill({ status: 204 }));
      let response: unknown = observed();
      let responseCode = 200;
      let requests = 0;
      await page.route('**/api/sessions/*/retrieval-readiness', (route) => {
        requests++;
        return route.fulfill({ status: responseCode, json: response });
      });
      await page.goto('/');
      await page.getByRole('button', { name: 'Chat', exact: true }).click();
      await expect.poll(() => fixture.sockets.has(session.id)).toBe(true);
      await page.locator('html').evaluate((element, scale) => {
        element.style.fontSize = `${scale}%`;
      }, fontScale);
      expect(requests).toBe(0);
      await page.getByRole('button', { name: 'Open configuration' }).click();
      const region = page.getByRole('region', { name: 'Repository tools' });
      const summary = region.locator('summary');
      await expect(summary).toHaveAccessibleName('Repository tool readiness: Unverified');
      await summary.focus();
      await page.keyboard.press('Enter');
      await expect(region.locator('details')).toHaveAttribute('open', '');
      await expect(region).toContainText('Compiler selection is unverified');
      await expect(region.getByText('Repository index')).toBeVisible();
      const discovery = page.getByRole('region', { name: 'Workspace discovery' });
      await expect(discovery).toContainText('The workspace index contains no records.');
      await expect(discovery.getByText('XERJ service').locator('..')).toContainText('Ready');
      await expect(discovery.getByText('Indexer', { exact: true }).locator('..')).toContainText(
        'watching',
      );
      await expect(page.locator('#configuration-panel')).not.toContainText('/private/');
      response = observed('unavailable');
      await region.getByRole('button', { name: 'Refresh tool readiness' }).click();
      await expect(summary).toHaveAccessibleName('Repository tool readiness: Degraded');
      await expect(region.getByText('References').locator('..')).toContainText('Degraded');
      const refresh = region.getByRole('button', { name: 'Refresh tool readiness' });
      await refresh.focus();
      await expect(refresh).toBeFocused();
      expect(
        await page
          .locator('#configuration-panel')
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      expect(
        await discovery
          .locator('dd')
          .evaluateAll((elements) =>
            elements.every(
              (element) =>
                getComputedStyle(element).whiteSpace !== 'nowrap' &&
                element.scrollWidth <= element.clientWidth,
            ),
          ),
      ).toBe(true);
      await mkdir(evidence, { recursive: true });
      const metrics = await region.evaluate((element) => {
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
            .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
        const ratios = [...element.querySelectorAll('p,dt,dd,h2,summary')].map((target) => {
          let background = [255, 255, 255, 255];
          for (let parent: Element | null = target; parent; parent = parent.parentElement) {
            const candidate = rgb(getComputedStyle(parent).backgroundColor);
            if (candidate[3] === 255) {
              background = candidate;
              break;
            }
          }
          const foreground = rgb(getComputedStyle(target).color);
          const a = luminance(foreground),
            b = luminance(background);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        });
        const panel = element.closest('#configuration-panel')!;
        return {
          minimumContrast: Math.min(...ratios),
          rootFontSize: getComputedStyle(document.documentElement).fontSize,
          panelClientWidth: panel.clientWidth,
          panelScrollWidth: panel.scrollWidth,
          paragraphMeasure: getComputedStyle(element.querySelector('p')!).maxInlineSize,
        };
      });
      expect(metrics.minimumContrast).toBeGreaterThanOrEqual(4.5);
      expect(metrics.rootFontSize).toBe(`${(16 * fontScale) / 100}px`);
      await writeFile(
        `${evidence}/metrics-${viewport.width}-font${fontScale}.json`,
        JSON.stringify(metrics, null, 2),
      );
      await summary.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${evidence}/status-${viewport.width}-font${fontScale}.png` });
      await refresh.focus();
      if (fontScale === 200) {
        await refresh.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `${evidence}/status-controls-${viewport.width}-font${fontScale}.png`,
        });
      }
      await writeFile(
        `${evidence}/status-${viewport.width}-font${fontScale}.aria.txt`,
        await region.ariaSnapshot(),
      );
      const beforeEvents = requests;
      let sequence = 0;
      for (const [state, second, expected] of [
        ['stale', 2, 'Stale'],
        ['ready', 1, 'Stale'],
        ['ready', 3, 'Ready on observed source'],
      ] as const) {
        const notification = normalizeCodexNotification(
          session.id,
          ++sequence,
          `2026-10-26T12:00:0${second}Z`,
          {
            method: 'gestalt/retrievalReadiness',
            params: { ...observed(state).repositories[0], runtimeId: 'fixture-runtime' },
          },
        )!;
        fixture.event(
          session.id,
          sequence,
          notification.type,
          notification.payload,
          notification.occurredAt,
        );
        // Wait for the journal activity to render before asserting that its
        // older readiness payload did not upgrade the current status.
        await expect(page.locator('body')).toContainText(
          `Semantic checks · ${state === 'stale' ? 'stale' : 'ready'}`,
        );
        await expect(summary).toHaveAccessibleName(`Repository tool readiness: ${expected}`);
      }
      expect(requests).toBe(beforeEvents);
      await page.keyboard.press('Escape');
      await page.getByText(/^Work details/).click();
      await expect(page.getByText('Semantic checks · ready', { exact: true })).toBeVisible();
      await expect(
        page.getByText(
          /Observed source only; compiler selection and repository index coverage are unverified/,
        ),
      ).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeEnabled();
      await page.screenshot({
        path: `${evidence}/activity-${viewport.width}-font${fontScale}.png`,
      });
      if (fontScale === 200) {
        const content = page.getByText(
          /Observed source only; compiler selection and repository index coverage are unverified/,
        );
        const endMetrics = await content.evaluate((element) => {
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            if (
              parent.scrollHeight > parent.clientHeight &&
              /auto|scroll/.test(getComputedStyle(parent).overflowY)
            )
              parent.scrollTo({ top: parent.scrollHeight, behavior: 'instant' });
          }
          element.scrollIntoView({ block: 'end', behavior: 'instant' });
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
          const range = document.createRange();
          range.selectNodeContents(element);
          const last = range.getClientRects();
          const end = last[last.length - 1];
          const nav = document.querySelector('nav')?.getBoundingClientRect();
          return {
            visible: end.bottom <= Math.min(innerHeight, nav?.top ?? innerHeight) && end.top >= 0,
            endTop: end.top,
            endBottom: end.bottom,
            navTop: nav?.top,
            scrollY,
            documentHeight: document.documentElement.scrollHeight,
          };
        });
        await writeFile(
          `${evidence}/activity-end-${viewport.width}-font${fontScale}.json`,
          JSON.stringify(endMetrics, null, 2),
        );
        expect(endMetrics.visible).toBe(true);
        await page.screenshot({
          path: `${evidence}/activity-end-${viewport.width}-font${fontScale}.png`,
        });
      }
      await page.getByRole('button', { name: 'Open configuration' }).click();
      response = observed('ready');
      await refresh.click();
      await expect(summary).toHaveAccessibleName(
        'Repository tool readiness: Ready on observed source',
      );
      response = {
        runtimeId: 'new-runtime',
        observedAt: '2026-10-26T12:00:00Z',
        connections: [],
        repositories: [],
      };
      const beforeReconnect = requests;
      const socket = fixture.sockets.get(session.id);
      fixture.close(session.id);
      await expect(summary).toHaveAccessibleName('Repository tool readiness: Unverified');
      await expect.poll(() => fixture.sockets.get(session.id) !== socket).toBe(true);
      await expect.poll(() => requests).toBeGreaterThan(beforeReconnect);
      await expect(region).toHaveAttribute('aria-busy', 'false');
      await expect(region).toContainText('No repository evidence yet.');
      for (const [runtimeId, time, label] of [
        ['fixture-runtime', '2026-10-26T12:00:03Z', 'older-replayed-fork'],
        ['new-runtime', '2026-10-26T11:59:59Z', 'same-runtime-replayed-fork'],
      ]) {
        const replay = observed('ready').repositories[0];
        replay.readiness.repository!.label = label;
        const event = normalizeCodexNotification(session.id, ++sequence, time, {
          method: 'gestalt/retrievalReadiness',
          params: { ...replay, runtimeId },
        })!;
        fixture.event(session.id, sequence, event.type, event.payload, event.occurredAt);
        await expect(page.locator('body')).toContainText(label);
        await expect(summary).toHaveAccessibleName('Repository tool readiness: Unverified');
      }
      response = {};
      await refresh.click();
      await expect(summary).toHaveAccessibleName('Repository tool readiness: Unverified');
      responseCode = 404;
      await refresh.click();
      await expect(summary).toHaveAccessibleName('Repository tool readiness: Unverified');
      responseCode = 503;
      response = { error: 'private token-secret' };
      await refresh.click();
      await page.keyboard.press('Escape');
      await expect(
        page.getByRole('status').filter({ hasText: 'Could not refresh tool readiness.' }),
      ).toBeVisible();
      await expect(page.locator('body')).not.toContainText('token-secret');
      await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeEnabled();
    });
  }
}
