/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const evidenceDirectory = '/tmp/gestalt-mobile-skills-evidence';
const viewports = [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 768, height: 1024 }] as const;
const themes = ['light', 'dark'] as const;
const fontScales = [100, 200] as const;
const states = ['list', 'expanded-details', 'unsaved-new-profile', 'saved', 'warning', 'empty', 'error'] as const;

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
  await page.route('**/api/skill-profiles', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ profiles: [] }) }));
  await page.route('**/api/skills?*', (route) => {
    if (state === 'error') return route.fulfill({ status: 502, contentType: 'application/problem+json', body: JSON.stringify({ detail: 'Skill discovery failed.' }) });
    const payload = state === 'empty' ? { ...skills, skills: [] } : state === 'warning' ? { ...skills, errors: [{ message: 'A secondary scope was unavailable.' }] } : skills;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.route('**/api/skill-profiles/*', (route) => route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ version: 1, name: 'new-profile', path: '/profiles/new-profile.yml', skills: skills.skills.map(({ name, path, effectiveEnabled }) => ({ name, path, enabled: effectiveEnabled })) }) }));
  await page.goto('/');
  await page.addStyleTag({ content: `html { font-size: ${scale}% !important; }` });
  await page.getByRole('button', { name: 'Skills' }).click();
  await expect(page.getByRole('heading', { name: 'Skills' })).toBeVisible();
}

for (const viewport of viewports) for (const theme of themes) for (const scale of fontScales) {
  test(`captures seven Skills states ${viewport.width}x${viewport.height} ${theme} ${scale}%`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const state of states) {
      await open(page, theme, scale, state);
      if (state === 'expanded-details') {
        await page.getByText('Skill details').click();
        await expect(page.getByText('/very/long/workspace/path/skills/Long-Skill/SKILL.md')).toBeVisible();
      }
      if (state === 'unsaved-new-profile') {
        await page.getByLabel('Save as').fill('new-profile');
        await expect(page.getByText('Creating a new saved profile.')).toBeVisible();
      }
      if (state === 'saved') {
        await page.getByLabel('Save as').fill('new-profile');
        await page.getByRole('button', { name: 'Save profile' }).click();
        await expect(page.getByText('Profile saved.')).toBeVisible();
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
      await page.screenshot({ path: `${evidenceDirectory}/skills-${state}-${viewport.width}x${viewport.height}-font${scale}-${theme}.png`, fullPage: false });
    }
  });
}
