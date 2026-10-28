/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { openThemeEvidence } from './theme-evidence.js';
import type { RelaySkillProfile } from '../../src/client/features/sessions/relay-client.js';

async function mockProfiles(page: Page) {
  let profiles: RelaySkillProfile[] = [
    { version: 1, name: 'legacy', path: '/profiles/legacy.yml', skills: [] },
  ];
  let failSave = false;
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      json: {
        workspaces: [
          { id: 'w', name: 'workspace', relativePath: '.', isGitRepository: false, children: [] },
        ],
        profiles: [{ name: 'default', state: 'ok', status: 'ready' }],
        sessions: [],
      },
    }),
  );
  await page.route('**/api/skill-profiles', (route) => route.fulfill({ json: { profiles } }));
  await page.route('**/api/skills?*', (route) =>
    route.fulfill({ json: { source: 'native', errors: [], skills: [] } }),
  );
  await page.route('**/api/skill-profiles/*', (route) => {
    if (failSave)
      return route.fulfill({
        status: 500,
        json: {
          code: 'SKILL_PROFILE_PERSISTENCE_FAILED',
          detail: 'Profile could not be saved. Try again.',
        },
      });
    const body = route.request().postDataJSON() as Omit<RelaySkillProfile, 'path'>;
    const saved = { ...body, path: `/profiles/${body.name}.yml` };
    profiles = [...profiles.filter((profile) => profile.name !== body.name), saved];
    return route.fulfill({ status: 201, json: saved });
  });
  await mockAuthenticatedStatus(page);
  return {
    fail: () => {
      failSave = true;
    },
  };
}

async function openManager(page: Page) {
  await page.getByText('Advanced settings', { exact: true }).click();
  await page.getByRole('button', { name: 'Manage skill profiles' }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Manage skill profiles' })).toBeFocused();
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  for (const fontScale of [100, 200] as const) {
    for (const theme of ['minimal-light', 'minimal-dark'] as const) {
      test(`browser consent ${viewport.width}x${viewport.height} ${fontScale}% ${theme}`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize(viewport);
        await mockProfiles(page);
        await openThemeEvidence(page, { theme, fontScale, url: '/' });
        await openManager(page);
        const toggle = page.getByRole('checkbox', { name: 'Browser access (Playwright)' });
        await expect(toggle).not.toBeChecked();
        await expect(page.getByText('Off · browser access disabled')).toBeVisible();
        for (const state of ['off', 'unavailable']) {
          if (state === 'unavailable') {
            await toggle.focus();
            await toggle.press('Space');
            await expect(toggle).toBeChecked();
            await expect(page.getByText('Configured · runtime unavailable')).toBeVisible();
          }
          await toggle.scrollIntoViewIfNeeded();
          const overflow = await page.evaluate(() => ({
            page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            editor: [
              ...document.querySelectorAll<HTMLElement>('.skills-view, .browser-access'),
            ].map((element) => element.scrollWidth - element.clientWidth),
          }));
          expect(overflow).toEqual({ page: 0, editor: [0, 0] });
          const splitWords = await page.locator('.browser-toggle span').evaluate((label) => {
            const text = label.firstChild;
            if (!text?.textContent) return ['missing label'];
            return [...text.textContent.matchAll(/\S+/g)]
              .filter((word) => {
                const range = document.createRange();
                range.setStart(text, word.index!);
                range.setEnd(text, word.index! + word[0].length);
                return range.getClientRects().length !== 1;
              })
              .map((word) => word[0]);
          });
          expect(splitWords).toEqual([]);
          await page.screenshot({
            path: testInfo.outputPath(
              `browser-${state}-${viewport.width}x${viewport.height}-font${fontScale}-${theme}.png`,
            ),
          });
        }
        await page.getByLabel('Save as').fill('browser');
        await page.getByRole('button', { name: 'Save profile' }).press('Enter');
        await expect(page.getByText('Profile saved.')).toBeVisible();
        await page.getByRole('button', { name: 'Close skill profile editor' }).click();
        await page.getByRole('button', { name: 'Manage skill profiles' }).click();
        await page.getByLabel('Skill profile', { exact: true }).selectOption('browser');
        await expect(toggle).toBeChecked();
        await page.getByLabel('Skill profile', { exact: true }).selectOption('legacy');
        await expect(toggle).not.toBeChecked();
      });
    }
  }
}

test('failed browser-profile save uses the shared toast and preserves consent', async ({
  page,
}) => {
  const mock = await mockProfiles(page);
  await page.goto('/');
  await openManager(page);
  await page.getByLabel('Save as').fill('browser');
  await page.getByRole('checkbox', { name: 'Browser access (Playwright)' }).check();
  mock.fail();
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByLabel('Notifications').getByRole('alert')).toContainText(
    'Profile could not be saved. Try again.',
  );
  await expect(page.getByRole('checkbox', { name: 'Browser access (Playwright)' })).toBeChecked();
});
