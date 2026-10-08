/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { normalizeCodexNotification } from '../../src/server/platform/codex/normalizer.js';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture } from './chat-relay-fixture.js';

const evidence = '/tmp/serena-mobile-browser';
const failureMessage =
  'Serena is unavailable in this session. Use native code tools. Connection availability will be checked when the runtime resumes.';
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
]) {
  for (const fontScale of [100, 200]) {
    test(`Serena versions and session MCP feedback ${viewport.width}px font${fontScale}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await mockAuthenticatedStatus(page);
      const fixture = new ChatRelayFixture(page);
      const session = {
        id: 'serena-session',
        state: 'ready',
        threadId: 'serena-thread',
        provider: 'codex',
        workspaceId: 'workspace',
        workspacePath: '/one/project',
        profile: 'default',
        activeTurnId: null,
      };
      await fixture.install([session]);
      await page.route('**/api/skill-profiles', (route) =>
        route.fulfill({ json: { profiles: [] } }),
      );
      await page.route('**/api/bootstrap', (route) =>
        route.fulfill({
          json: {
            workspaces: [],
            profiles: [],
            sessions: [session],
            versions: [
              { id: 'gestalt', label: 'Gestalt manager', version: '0.1.0' },
              { id: 'gestalt-mobile', label: 'Gestalt Mobile', version: '0.1.0' },
              { id: 'gestalt-agents', label: 'Gestalt Agents', version: '2.15.0' },
              { id: 'context-mode', label: 'Context Mode', version: '2.15.0' },
              { id: 'xerj', label: 'xerj', version: '1.0.0-rc.87' },
              { id: 'codex', label: 'Codex CLI', version: '0.160.0' },
              { id: 'serena', label: 'Serena', version: '1.7.0' },
              { id: 'uv', label: 'uv', version: '0.11.12' },
              { id: 'serena-python', label: 'Serena Python', version: null },
            ],
          },
        }),
      );
      await page.goto('/');
      await expect(page.locator('body')).not.toContainText('Unexpected token');
      await page.locator('html').evaluate((element, scale) => {
        element.style.fontSize = `${scale}%`;
      }, fontScale);
      await page.getByRole('button', { name: 'Open configuration' }).click();
      const versions = page.getByRole('region', { name: 'Versions' });
      await versions.scrollIntoViewIfNeeded();
      await expect(versions).toContainText('Serena');
      await expect(versions).toContainText('1.7.0');
      await expect(versions).toContainText('0.11.12');
      const unavailable = versions.locator('dd[title="Version unavailable"]');
      await expect(unavailable).toHaveText('Unavailable');
      expect(
        await page
          .locator('#configuration-panel')
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      const bounds = await versions.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      await mkdir(evidence, { recursive: true });
      await page.screenshot({
        path: `${evidence}/versions-${viewport.width}-font${fontScale}.png`,
      });
      if (viewport.width === 390 && fontScale === 200) {
        const panel = page.locator('#configuration-panel');
        expect(
          await panel.evaluate(
            (element) =>
              element.scrollHeight > element.clientHeight &&
              ['auto', 'scroll'].includes(getComputedStyle(element).overflowY),
          ),
        ).toBe(true);
        const quit = panel.getByRole('button', { name: 'Quit', exact: true });
        await quit.focus();
        await expect(quit).toBeFocused();
        expect(
          await quit.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const panel = element.closest('#configuration-panel')!.getBoundingClientRect();
            return bounds.top >= panel.top && bounds.bottom <= Math.min(panel.bottom, innerHeight);
          }),
        ).toBe(true);
        await page.screenshot({ path: `${evidence}/versions-controls-390-font200.png` });
      }
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Chat', exact: true }).click();
      await expect.poll(() => fixture.sockets.has(session.id)).toBe(true);
      const connected = normalizeCodexNotification(session.id, 1, '2026-10-08T12:00:00Z', {
        method: 'mcpServer/statusUpdated',
        params: { name: 'gestalt-serena', status: 'connected' },
      })!;
      fixture.event(session.id, 1, connected.type, connected.payload, connected.occurredAt);
      await page.getByText(/^Work details/).click();
      await expect(page.getByText('Serena connected', { exact: true })).toBeVisible();
      await expect(page.getByText(/language readiness is still unverified/)).toBeVisible();
      await expect(
        page.getByRole('status').filter({ hasText: 'Serena is unavailable' }),
      ).toHaveCount(0);
      const failed = normalizeCodexNotification(session.id, 2, '2026-10-08T12:00:01Z', {
        method: 'mcpServer/statusUpdated',
        params: { name: 'gestalt-serena', status: 'failed', error: 'private secret-token' },
      })!;
      fixture.event(session.id, 2, failed.type, failed.payload, failed.occurredAt);
      const warning = page
        .getByRole('status')
        .filter({ hasText: 'Serena is unavailable in this session.' });
      await expect(warning).toBeVisible();
      await expect(warning).toContainText(failureMessage);
      await expect(page.getByText('Serena unavailable', { exact: true })).toBeVisible();
      await expect(page.locator('body')).not.toContainText('secret-token');
      await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeEnabled();
      await page.screenshot({
        path: `${evidence}/unavailable-${viewport.width}-font${fontScale}.png`,
      });
      if (viewport.width === 390 && fontScale === 200) {
        await warning.hover();
        await page.mouse.wheel(0, 1000);
        await expect
          .poll(() =>
            warning.evaluate((element) => {
              const copy = element.querySelector('.toast-copy > span')!;
              const text = copy.firstChild!;
              const range = document.createRange();
              range.setStart(text, text.textContent!.indexOf('runtime resumes.'));
              range.setEnd(text, text.textContent!.length);
              const end = range.getBoundingClientRect();
              const bounds = element.getBoundingClientRect();
              return (
                getComputedStyle(element).overflowY === 'auto' &&
                element.scrollTop > 0 &&
                end.top >= bounds.top &&
                end.bottom <= bounds.bottom
              );
            }),
          )
          .toBe(true);
        await page.screenshot({ path: `${evidence}/unavailable-end-390-font200.png` });
      }
      await warning.getByRole('button', { name: 'Dismiss warning notification' }).click();
      await page.getByRole('button', { name: 'Open configuration' }).click();
      await page.getByRole('button', { name: 'Notifications', exact: true }).click();
      await expect(page.getByRole('list', { name: 'Recent notifications' })).toContainText(
        failureMessage,
      );
    });
  }
}

test('starts a readonly session with optional Serena failure and keeps chat usable', async ({
  page,
}) => {
  await mockAuthenticatedStatus(page);
  const fixture = new ChatRelayFixture(page);
  await fixture.install([]);
  const warning =
    'Serena is unavailable in this session. Use native code tools. Connection availability will be checked when the runtime resumes.';
  const session = {
    id: 'serena-start',
    state: 'ready',
    threadId: 'serena-start-thread',
    provider: 'codex',
    workspaceId: 'workspace',
    workspacePath: '/one/project',
    profile: 'default',
    activeTurnId: null,
    effectiveSkillSelection: {
      serenaSelected: true,
      skills: [{ name: 'gestalt:serena', path: '/plugin/serena/SKILL.md', enabled: false }],
      warnings: [warning],
    },
  };
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      json: {
        workspaces: [
          {
            id: 'workspace',
            name: 'project',
            relativePath: '.',
            isGitRepository: true,
            children: [],
          },
        ],
        profiles: [],
        sessions: [],
      },
    }),
  );
  await page.route('**/api/skill-profiles', (route) => route.fulfill({ json: { profiles: [] } }));
  await page.route('**/api/sessions', (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: fixture.sessions });
    expect(route.request().postDataJSON()).toMatchObject({
      workspaceId: 'workspace',
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
    fixture.sessions.push(session);
    return route.fulfill({ status: 202, json: session });
  });
  await page.goto('/');
  await page.getByText('Advanced settings', { exact: true }).click();
  await page.getByLabel('Sandbox').selectOption('read-only');
  await page.getByLabel('Approval policy').selectOption('never');
  await page.getByRole('button', { name: 'Create session' }).click();
  await expect(page.getByRole('button', { name: 'Chat', pressed: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: warning })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeEnabled();
});

test('hides automatic Serena from the skills editor and removes legacy profile entries', async ({
  page,
}) => {
  await mockAuthenticatedStatus(page);
  const path = '/plugin/serena/SKILL.md';
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      json: {
        workspaces: [
          {
            id: 'workspace',
            name: 'project',
            relativePath: '.',
            isGitRepository: true,
            children: [],
          },
        ],
        profiles: [{ name: 'default', state: 'ok', status: 'ready' }],
        sessions: [],
      },
    }),
  );
  await page.route('**/api/skills?*', (route) =>
    route.fulfill({
      json: {
        source: 'native',
        errors: [],
        skills: [
          {
            name: 'gestalt:serena',
            path,
            nativeEnabled: true,
            effectiveEnabled: true,
            alwaysAdvertised: false,
          },
        ],
      },
    }),
  );
  await page.route('**/api/skill-profiles', (route) =>
    route.fulfill({
      json: {
        profiles: [
          {
            version: 1,
            name: 'semantic',
            path: '/profiles/semantic.yml',
            skills: [{ name: 'gestalt:serena', path, enabled: true }],
          },
        ],
      },
    }),
  );
  let saved: unknown;
  await page.route('**/api/skill-profiles/semantic', (route) => {
    saved = route.request().postDataJSON();
    return route.fulfill({
      status: 200,
      json: { ...(saved as object), path: '/profiles/semantic.yml' },
    });
  });
  await page.goto('/');
  await page.getByText('Advanced settings', { exact: true }).click();
  await page.getByRole('button', { name: 'Manage skill profiles' }).click();
  await page.getByLabel('Skill profile', { exact: true }).selectOption('semantic');
  const checkbox = page.getByRole('checkbox', { name: /gestalt:serena/ });
  await expect(checkbox).toHaveCount(0);
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect.poll(() => saved).toMatchObject({ skills: [] });
});
