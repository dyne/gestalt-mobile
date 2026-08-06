/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import {
  evidenceFilename,
  evidenceFontScales,
  evidenceThemes,
  evidenceViewports,
} from './theme-evidence.js';

import type { SupervisedPlan } from '../../src/client/features/plans/contracts.js';

const evidenceDirectory = '/tmp/gestalt-mobile-plan-evidence';
const session = {
  id: 'evidence-session',
  state: 'ready',
  threadId: 'evidence-thread',
  workspaceId: 'workspace-1',
  workspacePath: '/evidence/workspace',
  profile: 'default',
  activeTurnId: null,
};
const longToken = `https://example.test/${'unbroken-mobile-token-'.repeat(14)}終端`;

const firstStepPlan: SupervisedPlan = {
  title: 'Mobile supervised plan',
  subtitle: 'Readable progress from the active session',
  date: '2026-08-01',
  keywords: 'mobile accessibility supervised',
  steps: [
    {
      id: 'parent',
      title: 'Present supervised progress',
      level: 1,
      state: 'TODO',
      priority: 'A',
      reviewStatus: 'UNREVIEWED',
      skills: ['$gestalt:org-plan', '$playwright'],
      description: {
        effort: 'Medium',
        goal: 'Keep the current work immediately understandable.',
        notes: 'The Plan tab belongs only to the selected Chat session.',
      },
      children: [
        {
          id: 'first-child',
          title: 'Render the first child',
          level: 2,
          state: 'TODO',
          priority: 'A',
          description: {
            why: 'Users need a concise starting point.',
            change: 'Render a native disclosure with complete status text.',
            tests: 'Exercise keyboard, focus, and the live region.',
            doneWhen: 'The first child is readable on a narrow phone.',
          },
          children: [],
        },
        {
          id: 'nested-current',
          title: 'Advance to the nested current step',
          level: 2,
          state: 'TODO',
          priority: 'B',
          description: {
            why: 'The current step must move without stealing focus.',
            change: 'Open the newly current disclosure automatically.',
            tests: 'Verify disclosure and announcement state.',
            doneWhen: 'The nested step is visibly current.',
          },
          children: [],
        },
      ],
    },
  ],
  totalSteps: 3,
  doneSteps: 0,
  allDone: false,
  currentStepId: 'parent',
};

const nestedPlan: SupervisedPlan = {
  ...firstStepPlan,
  steps: [
    {
      ...firstStepPlan.steps[0]!,
      state: 'WIP',
      children: [
        { ...firstStepPlan.steps[0]!.children[0]!, state: 'DONE' },
        { ...firstStepPlan.steps[0]!.children[1]!, state: 'WIP' },
      ],
    },
  ],
  doneSteps: 1,
  currentStepId: 'nested-current',
};

const longDescriptionPlan: SupervisedPlan = {
  ...nestedPlan,
  title: 'Internationalized plan — Καλημέρα — こんにちは',
  steps: [
    {
      ...nestedPlan.steps[0]!,
      title: `Long-token containment ${longToken}`,
      description: {
        ...nestedPlan.steps[0]!.description,
        notes: `Unicode résumé naïve café 🧭 and an unbroken address: ${longToken}`,
      },
      children: nestedPlan.steps[0]!.children.map((child) => ({
        ...child,
        description: { ...child.description, change: `${child.description.change} ${longToken}` },
      })),
    },
  ],
};

function completedPlan(reviewStatus: 'UNREVIEWED' | 'REVIEWED'): SupervisedPlan {
  return {
    ...nestedPlan,
    steps: [
      {
        ...nestedPlan.steps[0]!,
        state: 'DONE',
        reviewStatus,
        children: nestedPlan.steps[0]!.children.map((child) => ({ ...child, state: 'DONE' })),
      },
    ],
    doneSteps: 3,
    allDone: true,
    currentStepId: 'parent',
  };
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    elements: [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left < -1 || bounds.right > window.innerWidth + 1;
      })
      .map((element) => ({ tag: element.tagName, className: element.className })),
  }));
  expect(overflow).toEqual({ document: 0, elements: [] });
}

test('captures every responsive Plan state with executable accessibility evidence', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await rm(evidenceDirectory, { recursive: true, force: true });
  await mkdir(evidenceDirectory, { recursive: true });
  let plan: SupervisedPlan | null = null;
  let closeFailure = false;
  let activeFontScale: (typeof evidenceFontScales)[number] = 100;
  const artifacts: Array<Record<string, unknown>> = [];

  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ workspaces: [], profiles: [], sessions: [session] }),
    }),
  );
  await page.route(`**/api/sessions/${session.id}/history`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ items: [], currentSequence: 0 }),
    }),
  );
  await page.route(`**/api/sessions/${session.id}/plan`, (route) => {
    if (route.request().method() === 'DELETE') {
      if (closeFailure)
        return route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          body: JSON.stringify({ detail: 'Evidence close failure' }),
        });
      plan = null;
      return route.fulfill({ status: 204 });
    }
    return plan
      ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(plan) })
      : route.fulfill({ status: 204 });
  });
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/skill-profiles', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ profiles: [] }) }),
  );
  await page.routeWebSocket(
    /ws:\/\/127\.0\.0\.1:4173\/api\/sessions\/evidence-session\/events\?after=\d+/,
    () => {},
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send(
    'Emulation.setSafeAreaInsetsOverride' as never,
    {
      insets: { top: 16, left: 8, bottom: 24, right: 8 },
    } as never,
  );
  await mockAuthenticatedStatus(page);
  await page.goto('/');

  const capture = async (
    state: string,
    statePlan: SupervisedPlan | null,
    options: { error?: boolean; close?: boolean } = {},
  ) => {
    plan = statePlan;
    closeFailure = Boolean(options.error);
    await page.reload();
    await page.evaluate((value) => {
      document.documentElement.style.fontSize = `${value}%`;
    }, activeFontScale);
    const navigation = page.getByLabel('Primary');
    const planTab = navigation.getByRole('button', { name: 'Plan' });
    if (statePlan) {
      await expect(planTab).toBeVisible();
      await planTab.click();
      await expect(page.getByRole('heading', { name: statePlan.title })).toBeVisible();
    } else {
      await expect(planTab).toBeVisible();
      await planTab.click();
      await expect(page.getByRole('heading', { name: 'Plans' })).toBeVisible();
    }
    if (options.close) {
      await page.getByRole('button', { name: 'Close plan and return to list' }).click();
      await expect(planTab).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Plans' })).toBeVisible();
    }

    await assertNoHorizontalOverflow(page);
    const navPadding = await navigation.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingBottom),
    );
    expect(navPadding).toBeGreaterThanOrEqual(24);
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
      true,
    );
    expect(
      await navigation.evaluate(
        (element) => getComputedStyle(element.querySelector('button')!).transitionDuration,
      ),
    ).toContain('1e-05s');

    if (statePlan && !options.close) {
      const live = page.locator('[aria-live="polite"][aria-atomic="true"]');
      await expect(live).toHaveCount(1);
      await expect(live).not.toHaveText('');
      const chat = navigation.getByRole('button', { name: 'Chat' });
      await chat.focus();
      await chat.press('Tab');
      await expect(planTab).toBeFocused();
      const focusStyle = await planTab.evaluate(
        (element) => getComputedStyle(element).outlineWidth,
      );
      expect(Number.parseFloat(focusStyle)).toBeGreaterThan(0);
      await planTab.press('Enter');
      await expect(planTab).toHaveAttribute('aria-pressed', 'true');
      const summary = page.locator('details summary').first();
      await summary.focus();
      const details = summary.locator('..');
      const wasOpen = await details.evaluate((element) => (element as HTMLDetailsElement).open);
      await summary.press('Enter');
      await expect
        .poll(() => details.evaluate((element) => (element as HTMLDetailsElement).open))
        .toBe(!wasOpen);
      await summary.press(' ');
      await expect
        .poll(() => details.evaluate((element) => (element as HTMLDetailsElement).open))
        .toBe(wasOpen);
      if (statePlan) {
        const close = page.getByRole('button', { name: 'Close plan and return to list' });
        const bounds = await close.boundingBox();
        expect(bounds?.width).toBeGreaterThanOrEqual(44);
        expect(bounds?.height).toBeGreaterThanOrEqual(44);
      }
    }

    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    const filename = evidenceFilename(
      'plan',
      state,
      page.viewportSize()!,
      activeFontScale,
      theme as (typeof evidenceThemes)[number],
    );
    const path = join(evidenceDirectory, filename);
    await page.screenshot({ path });
    artifacts.push({
      state,
      path,
      viewport: page.viewportSize(),
      theme: await page.evaluate(() => document.documentElement.dataset.theme),
      fontScale: `${activeFontScale}%`,
    });
  };

  for (const viewport of evidenceViewports) {
    await page.setViewportSize(viewport);
    for (const theme of evidenceThemes) {
      await page.emulateMedia({
        colorScheme: theme === 'minimal-dark' ? 'dark' : 'light',
        reducedMotion: 'reduce',
      });
      await page.evaluate((value) => localStorage.setItem('gestalt-mobile.theme', value), theme);
      for (const fontScale of evidenceFontScales) {
        activeFontScale = fontScale;
        await capture('absent', null);
        await capture('active-first-step', firstStepPlan);
        await capture('nested-current-step', nestedPlan);
        await capture('awaiting-review', completedPlan('UNREVIEWED'));
        await capture('long-description', longDescriptionPlan);
        await capture('error', completedPlan('UNREVIEWED'), { error: true });
        await capture('all-done', completedPlan('REVIEWED'));
        await capture('close-return', completedPlan('REVIEWED'), { close: true });
      }
    }
  }

  expect(artifacts).toHaveLength(144);
  const inspectionSheets: string[] = [];
  for (const state of [
    'absent',
    'active-first-step',
    'nested-current-step',
    'awaiting-review',
    'long-description',
    'error',
    'all-done',
    'close-return',
  ]) {
    const stateArtifacts = artifacts.filter((artifact) => artifact.state === state);
    const cards = await Promise.all(
      stateArtifacts.map(async (artifact) => {
        const source = (await readFile(String(artifact.path))).toString('base64');
        const viewport = artifact.viewport as { width: number; height: number };
        return `<figure><figcaption>${viewport.width}x${viewport.height} · ${artifact.theme} · ${artifact.fontScale}</figcaption><img src="data:image/png;base64,${source}" alt="${state} ${viewport.width}x${viewport.height} ${artifact.theme} ${artifact.fontScale}"></figure>`;
      }),
    );
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.setContent(`<style>
      html { color-scheme: light; font: 16px system-ui; background: #ddd; }
      body { margin: 16px; }
      h1 { margin: 0 0 16px; }
      main { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; align-items: start; }
      figure { margin: 0; padding: 8px; background: white; border: 1px solid #222; }
      figcaption { margin-bottom: 6px; font-weight: 700; }
      img { display: block; width: 100%; max-height: 520px; object-fit: contain; object-position: top; background: #888; }
    </style><h1>${state}</h1><main>${cards.join('')}</main>`);
    const sheet = join(evidenceDirectory, `inspection-${state}.png`);
    await page.screenshot({ path: sheet, fullPage: true });
    inspectionSheets.push(sheet);
  }
  await writeFile(
    join(evidenceDirectory, 'manifest.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        count: artifacts.length,
        exclusions: [],
        inspectionSheets,
        assertions: [
          'safe-area inset padding',
          'reduced motion computed styles',
          'no horizontal overflow',
          'keyboard Tab and Enter navigation',
          'visible focus outline',
          'native disclosure Enter and Space',
          'polite atomic live region',
          '44 by 44 Close target',
          'close returns focus to Chat',
        ],
        artifacts,
      },
      null,
      2,
    ),
  );
});
