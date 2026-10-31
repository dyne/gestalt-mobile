/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';

import { themes } from '../../src/client/features/theme/theme-registry.js';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { expectCleanThemeDiagnostics, openThemeEvidence } from './theme-evidence.js';

const verifiedSkill = {
  name: 'nuklear-gui',
  displayName: 'Nuklear GUI development with long names and wrapped metadata',
  description:
    'Build an optional immediate mode interface. This deliberately long description verifies readable wrapping beside the collection provenance and the ordinary skill selection.',
  path: '/home/developer/.codex-gestalt/gestalt-skills/skills/nuklear-gui/references/long-workspace-name/SKILL.md',
  scope: 'user',
  nativeEnabled: true,
  effectiveEnabled: true,
  alwaysAdvertised: false,
  provenance: {
    kind: 'gestalt-verified',
    repository: 'dyne/gestalt-skills',
    revision: 'a'.repeat(40),
  },
  dependencies: {
    tools: [
      { type: 'mcp', value: 'workspace-tools', description: 'Only when available at runtime.' },
    ],
  },
};

const ordinarySkill = {
  name: 'local-control',
  description:
    'An ordinary local skill keeps the same optional controls without a provenance badge.',
  path: '/home/developer/.agents/skills/local-control/SKILL.md',
  scope: 'user',
  nativeEnabled: true,
  effectiveEnabled: true,
  alwaysAdvertised: false,
};

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
]) {
  for (const theme of themes) {
    for (const fontScale of [100, 150]) {
      test(`verified skills ${viewport.width}x${viewport.height} ${theme.id} ${fontScale}%`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize(viewport);
        await page.route('**/api/bootstrap', (route) =>
          route.fulfill({
            json: {
              workspaces: [
                {
                  id: 'workspace',
                  name: 'workspace',
                  relativePath: '.',
                  isGitRepository: false,
                  children: [],
                },
              ],
              profiles: [{ name: 'default', state: 'ok', status: 'ready' }],
              sessions: [],
            },
          }),
        );
        await page.route('**/api/skill-profiles', (route) =>
          route.fulfill({ json: { profiles: [] } }),
        );
        await page.route('**/api/skills?*', (route) =>
          route.fulfill({
            json: {
              source: 'native',
              errors: [],
              skills: [
                ordinarySkill,
                verifiedSkill,
                {
                  name: 'gestalt:org-plan',
                  path: '/plugins/org-plan/SKILL.md',
                  nativeEnabled: true,
                  effectiveEnabled: true,
                  alwaysAdvertised: true,
                },
              ],
            },
          }),
        );
        await mockAuthenticatedStatus(page);
        const diagnostics = await openThemeEvidence(page, {
          theme: theme.id,
          fontScale: 100,
          url: '/',
        });
        if (fontScale !== 100)
          await page.addStyleTag({ content: `html { font-size: ${fontScale}% !important; }` });
        await page.getByText('Advanced settings', { exact: true }).click();
        await page.getByRole('button', { name: 'Manage skill profiles' }).click();
        const verified = page.getByRole('checkbox', {
          name: /Nuklear GUI.*Gestalt verified/,
        });
        const ordinary = page.getByRole('checkbox', { name: /local-control/ });
        await expect(verified).toBeChecked();
        await expect(verified).toBeEnabled();
        await expect(verified).toHaveAccessibleName(/Enabled$/);
        await expect(page.getByText('Gestalt verified', { exact: true })).toHaveCount(1);
        await expect(page.getByText('gestalt:org-plan', { exact: true })).toHaveCount(0);
        await expect(page.getByText('2 of 2 skills enabled.')).toBeVisible();
        await expect(ordinary.locator('..').getByText('Gestalt verified')).toHaveCount(0);
        await ordinary.focus();
        await ordinary.press('Tab');
        await expect(verified).toBeFocused();
        await expect(verified).toBeInViewport();
        await expect
          .poll(() =>
            verified.evaluate((element) => {
              const box = element.getBoundingClientRect();
              return (
                document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element
              );
            }),
          )
          .toBe(true);
        await expect(page.getByText('Gestalt verified', { exact: true })).toBeInViewport();
        const layout = await page.evaluate(() => {
          const badge = document.querySelector<HTMLElement>('.verified-badge')!;
          const style = getComputedStyle(badge);
          const luminance = (color: string) => {
            const channels = color
              .match(/[\d.]+/g)!
              .slice(0, 3)
              .map(Number)
              .map((value) => {
                const channel = value / 255;
                return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
              });
            return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
          };
          const foreground = luminance(style.color);
          const background = luminance(style.backgroundColor);
          return {
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            badge: badge.getBoundingClientRect().toJSON(),
            contrast:
              (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
            fontSize: style.fontSize,
          };
        });
        expect(layout.overflow).toBe(0);
        expect(layout.badge.left).toBeGreaterThanOrEqual(0);
        expect(layout.badge.right).toBeLessThanOrEqual(viewport.width);
        expect(layout.contrast).toBeGreaterThanOrEqual(4.5);
        await testInfo.attach('layout', {
          body: JSON.stringify(layout),
          contentType: 'application/json',
        });
        await page.screenshot({
          path: testInfo.outputPath('verified-skill-focused.png'),
          fullPage: false,
        });
        await verified.press('Space');
        await expect(verified).not.toBeChecked();
        await expect(verified).toHaveAccessibleName(/Disabled$/);
        await expect(ordinary).toBeChecked();
        await expect(page.getByText('1 of 2 skills enabled.')).toBeVisible();
        const save = page.getByRole('button', { name: 'Save profile', exact: true });
        const saveGeometry = () =>
          save.evaluate((element) => {
            const identify = (node: Element | null) =>
              node
                ? { tag: node.tagName, id: node.id, className: node.getAttribute('class') }
                : null;
            const box = element.getBoundingClientRect();
            const ancestors = [];
            for (let parent = element.parentElement; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent);
              ancestors.push({
                ...identify(parent),
                box: parent.getBoundingClientRect().toJSON(),
                scrollTop: parent.scrollTop,
                scrollHeight: parent.scrollHeight,
                clientHeight: parent.clientHeight,
                overflowY: style.overflowY,
              });
            }
            return {
              box: box.toJSON(),
              activeElement: identify(document.activeElement),
              centerHit: identify(
                document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
              ),
              header: document.querySelector('.app-header')?.getBoundingClientRect().toJSON(),
              navigation: document
                .querySelector('.bottom-navigation')
                ?.getBoundingClientRect()
                .toJSON(),
              viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
              ancestors,
            };
          });
        const beforeFocus = await saveGeometry();
        await save.focus();
        const immediateFocus = await saveGeometry();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        );
        const afterFrames = await saveGeometry();
        await testInfo.attach('save-focus-geometry', {
          body: JSON.stringify({ beforeFocus, immediateFocus, afterFrames }),
          contentType: 'application/json',
        });
        await expect(save).toBeFocused();
        await expect(save).toBeInViewport();
        await expect(save).toBeEnabled();
        await expect
          .poll(() =>
            save.evaluate((element) => {
              const box = element.getBoundingClientRect();
              return (
                document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element
              );
            }),
          )
          .toBe(true);
        await page.screenshot({ path: testInfo.outputPath('save-focused.png'), fullPage: false });
        expectCleanThemeDiagnostics(diagnostics);
      });
    }
  }
}
