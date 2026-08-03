/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';

const evidenceDirectory = '/tmp/gestalt-mobile-sessions-profile-evidence';
const viewports = [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 768, height: 1024 }] as const;
const themes = ['light', 'dark'] as const;
const fontScales = [100, 200] as const;
const states = ['session-form', 'profile-manager', 'confirmation', 'saved', 'deleted', 'warning', 'empty', 'error'] as const;

const bootstrap = {
  workspaces: [{ id: 'workspace', name: 'workspace', relativePath: '.', isGitRepository: false, children: [] }],
  profiles: [{ name: 'default', state: 'ok', status: 'ready' }],
  sessions: [],
};
const skills = {
  source: 'native', errors: [], skills: [{ name: 'Long Skill', description: 'A deliberately long skill description that must remain readable at two hundred percent text size.', path: '/very/long/workspace/path/skills/Long-Skill/SKILL.md', scope: 'workspace', nativeEnabled: true, effectiveEnabled: true, dependencies: { tools: [{ type: 'mcp', value: 'filesystem' }] } }],
};

test.beforeAll(async () => mkdir(evidenceDirectory, { recursive: true }));

async function open(page: Page, theme: string, scale: number, state: (typeof states)[number]): Promise<void> {
  await page.addInitScript((value) => localStorage.setItem('gestalt-mobile.theme', value), theme);
  await page.route('**/api/bootstrap', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(bootstrap) }));
  const profiles = state === 'empty' ? [] : [{ version: 1, name: 'team', path: '/profiles/team.yml', skills: [] }];
  await page.route('**/api/skill-profiles', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ profiles }) }));
  await page.route('**/api/skills?*', (route) => {
    if (state === 'error') return route.fulfill({ status: 502, contentType: 'application/problem+json', body: JSON.stringify({ detail: 'Skill discovery failed.' }) });
    const payload = state === 'empty' ? { ...skills, skills: [] } : state === 'warning' ? { ...skills, errors: [{ message: 'A secondary scope was unavailable.' }] } : skills;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.route('**/api/skill-profiles/*', (route) => {
    if (route.request().method() === 'DELETE') return route.fulfill({ status: 204 });
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ version: 1, name: 'new-profile', path: '/profiles/new-profile.yml', skills: skills.skills.map(({ name, path, effectiveEnabled }) => ({ name, path, enabled: effectiveEnabled })) }) });
  });
  await mockAuthenticatedStatus(page);
  await page.goto('/');
  await page.addStyleTag({ content: `html { font-size: ${scale}% !important; }` });
  await expect(page.getByLabel('Primary').getByRole('button')).toHaveText(['Sessions', 'Git', 'Chat']);
  const skillProfile = page.getByLabel('Skills profile');
  await expect(skillProfile).toBeVisible();
  await expect(skillProfile.locator('option').first()).toHaveText('Default');
  await expect(page.getByText('The selected skill set is fixed after this session is created.')).toHaveCount(0);
  if (state === 'session-form') return;
  const manager = page.getByRole('button', { name: 'Manage skill profiles' });
  await manager.click();
  await expect(page.getByRole('heading', { name: 'Manage skill profiles' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Sessions', pressed: true })).toBeVisible();
}

for (const viewport of viewports) for (const theme of themes) for (const scale of fontScales) {
  test(`captures Sessions profile workflow states ${viewport.width}x${viewport.height} ${theme} ${scale}%`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const state of states) {
      await open(page, theme, scale, state);
      if (state === 'profile-manager') {
        const skillToggle = page.getByRole('checkbox', { name: /Long Skill/ });
        await skillToggle.uncheck();
        await page.getByRole('button', { name: 'Sessions', pressed: true }).click();
        await expect(page.getByRole('button', { name: 'Manage skill profiles' })).toBeVisible();
        await page.getByRole('button', { name: 'Manage skill profiles' }).press('Enter');
        await expect(skillToggle).toBeChecked();
        await page.getByRole('button', { name: 'Close skill profile editor' }).press('Enter');
        await expect(page.getByRole('button', { name: 'Manage skill profiles' })).toBeFocused();
        await page.getByRole('button', { name: 'Manage skill profiles' }).press('Enter');
      }
      if (state === 'confirmation') {
        await page.getByLabel('Skill profile', { exact: true }).selectOption('team');
        await page.getByRole('button', { name: 'Delete profile' }).click();
        await expect(page.getByRole('heading', { name: 'Delete skill profile?' })).toBeVisible();
      }
      if (state === 'saved') {
        await page.getByLabel('Save as').fill('new-profile');
        await page.getByRole('button', { name: 'Save profile' }).click();
        await expect(page.getByText('Profile saved.')).toBeVisible();
      }
      if (state === 'deleted') {
        await page.getByLabel('Skill profile', { exact: true }).selectOption('team');
        await page.getByRole('button', { name: 'Delete profile' }).click();
        await page.getByLabel('Delete skill profile?').getByRole('button', { name: 'Delete profile' }).click();
        await expect(page.getByText('Profile deleted.')).toBeVisible();
      }
      await expect(page.getByLabel('Primary')).toBeVisible();
      const overflow = await page.evaluate(() => ({
        amount: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        offenders: [...document.querySelectorAll<HTMLElement>('body *')]
          .map((element) => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right }))
          .filter((element) => element.right > document.documentElement.clientWidth + 0.5)
          .slice(0, 8),
      }));
      expect(overflow.amount, JSON.stringify(overflow)).toBe(0);
      await page.screenshot({ path: `${evidenceDirectory}/sessions-${state}-${viewport.width}x${viewport.height}-font${scale}-${theme}.png`, fullPage: false });
    }
  });
}

test('refreshes new-session profile choices after create, replace, and delete', async ({ page }) => {
  let profiles = [{ version: 1 as const, name: 'team', path: '/profiles/team.yml', skills: [] }];
  await page.route('**/api/bootstrap', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(bootstrap) }));
  await page.route('**/api/skill-profiles', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ profiles }) }));
  await page.route('**/api/skills?*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(skills) }));
  await page.route('**/api/skill-profiles/*', async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    if (route.request().method() === 'DELETE') {
      profiles = profiles.filter((profile) => profile.name !== name);
      return route.fulfill({ status: 204 });
    }
    const body = route.request().postDataJSON() as { version: 1; name: string; skills: [] };
    const saved = { ...body, path: `/profiles/${name}.yml` };
    profiles = [...profiles.filter((profile) => profile.name !== name), saved];
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(saved) });
  });
  await mockAuthenticatedStatus(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Manage skill profiles' }).click();
  await page.getByLabel('Save as').fill('fresh');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await page.getByRole('button', { name: 'Close skill profile editor' }).click();
  await expect(page.getByLabel('Skills profile').locator('option')).toHaveText(['Default', 'team', 'fresh']);

  await page.getByRole('button', { name: 'Manage skill profiles' }).click();
  await page.getByLabel('Skill profile', { exact: true }).selectOption('team');
  await expect(page.getByText('Saved the selected profile.')).toBeVisible();
  await page.getByRole('button', { name: 'Save profile' }).click();
  await page.getByRole('button', { name: 'Close skill profile editor' }).click();
  await expect(page.getByLabel('Skills profile').locator('option')).toHaveCount(3);

  await page.getByRole('button', { name: 'Manage skill profiles' }).click();
  await page.getByLabel('Skill profile', { exact: true }).selectOption('fresh');
  await page.getByRole('button', { name: 'Delete profile' }).click();
  await page.getByLabel('Delete skill profile?').getByRole('button', { name: 'Delete profile' }).click();
  await page.getByRole('button', { name: 'Close skill profile editor' }).click();
  await expect(page.getByLabel('Skills profile').locator('option')).toHaveText(['Default', 'team']);
});
