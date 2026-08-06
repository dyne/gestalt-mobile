/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import {
  evidenceFilename,
  evidenceFontScales,
  evidenceThemes,
  evidenceViewports,
  expectCleanThemeDiagnostics,
  openThemeEvidence,
} from './theme-evidence.js';

const evidenceDirectory = '/tmp/gestalt-mobile-sessions-tree-evidence';

test.beforeAll(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
});

const workspaceTree = [
  {
    id: 'opaque:root',
    name: 'development-workspace-with-a-long-name',
    relativePath: '.',
    isGitRepository: false,
    children: [
      {
        id: 'opaque:dyne',
        name: 'dyne',
        relativePath: 'dyne',
        isGitRepository: false,
        children: [
          {
            id: 'opaque:mobile',
            name: 'mobile-applications-and-experiments',
            relativePath: 'dyne/mobile-applications-and-experiments',
            isGitRepository: false,
            children: [
              {
                id: 'opaque:gestalt-mobile%deep',
                name: 'gestalt-mobile-with-an-extraordinarily-long-repository-name',
                relativePath:
                  'dyne/mobile-applications-and-experiments/gestalt-mobile-with-an-extraordinarily-long-repository-name',
                isGitRepository: true,
                children: [],
              },
            ],
          },
          {
            id: 'opaque:docs',
            name: 'documentation-portal',
            relativePath: 'dyne/documentation-portal',
            isGitRepository: true,
            children: [],
          },
        ],
      },
      {
        id: 'opaque:personal',
        name: 'personal-projects',
        relativePath: 'personal-projects',
        isGitRepository: false,
        children: [],
      },
    ],
  },
];

async function openSessions(
  page: Page,
  theme: (typeof evidenceThemes)[number],
  fontScale: (typeof evidenceFontScales)[number],
) {
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree,
        profiles: [{ name: 'default', state: 'ok', status: 'ready' }],
        sessions: [],
      }),
    }),
  );
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/skill-profiles', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ profiles: [] }) }),
  );
  await page.route('**/api/sessions', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        body: JSON.stringify({ detail: 'Codex app-server is unavailable.' }),
      });
    }
    return route.fulfill({ contentType: 'application/json', body: '[]' });
  });

  await mockAuthenticatedStatus(page);
  const diagnostics = await openThemeEvidence(page, { theme, fontScale, url: '/' });
  await expect(page.getByRole('tree', { name: 'Session base' })).toBeVisible();
  return diagnostics;
}

async function expectReadableSelection(locator: Locator): Promise<void> {
  const contrast = await locator.evaluate((element) => {
    const channels = (color: string) =>
      (color.match(/\d+(?:\.\d+)?/g) ?? [])
        .slice(0, 3)
        .map(Number)
        .map((value) => value / 255)
        .map((value) =>
          value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
        );
    const luminance = (color: string) => {
      const values = channels(color);
      return 0.2126 * values[0]! + 0.7152 * values[1]! + 0.0722 * values[2]!;
    };
    const style = getComputedStyle(element);
    const values = [luminance(style.color), luminance(style.backgroundColor)].sort(
      (left, right) => right - left,
    );
    return (values[0]! + 0.05) / (values[1]! + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
}

async function expectUsableLayout(page: Page): Promise<void> {
  const touchTargets = await page.locator('button').evaluateAll((buttons) =>
    buttons
      .filter((button) => {
        const box = button.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || button.getClientRects().length === 0)
          return false;
        for (let element: HTMLElement | null = button; element; element = element.parentElement) {
          const style = getComputedStyle(element);
          if (
            element.hidden ||
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.visibility === 'collapse' ||
            style.contentVisibility === 'hidden' ||
            style.opacity === '0'
          )
            return false;
        }
        return true;
      })
      .map((button) => {
        const box = button.getBoundingClientRect();
        return { width: box.width, height: box.height, name: button.getAttribute('aria-label') };
      }),
  );
  const undersizedTargets = touchTargets.filter(({ width, height }) => width < 44 || height < 44);
  expect(undersizedTargets, JSON.stringify(undersizedTargets)).toEqual([]);

  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    tree: (() => {
      const tree = document.querySelector<HTMLElement>('[role="tree"]');
      return tree ? tree.scrollWidth - tree.clientWidth : 1;
    })(),
  }));
  expect(overflow).toEqual({ document: 0, tree: 0 });

  const navigationLayout = await page.getByLabel('Primary').evaluate((navigation) => {
    const viewportWidth = document.documentElement.clientWidth;
    const buttons = [...navigation.querySelectorAll('button')].map((button) => {
      const box = button.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
      };
    });
    return {
      buttons,
      withinViewport: buttons.every(({ left, right }) => left >= 0 && right <= viewportWidth),
      nonOverlapping: buttons.every((button, index) =>
        buttons.every(
          (other, otherIndex) =>
            index === otherIndex ||
            button.right <= other.left ||
            other.right <= button.left ||
            button.bottom <= other.top ||
            other.bottom <= button.top,
        ),
      ),
    };
  });
  expect(navigationLayout.withinViewport, JSON.stringify(navigationLayout.buttons)).toBe(true);
  expect(navigationLayout.nonOverlapping, JSON.stringify(navigationLayout.buttons)).toBe(true);
  expect(navigationLayout.buttons).toHaveLength(4);
  expect(
    Math.max(...navigationLayout.buttons.map(({ width }) => width)) -
      Math.min(...navigationLayout.buttons.map(({ width }) => width)),
  ).toBeLessThanOrEqual(1);

  const order = await page.evaluate(() => {
    const tree = document.querySelector('[role="tree"]');
    const sandbox = document.querySelector('#sandbox');
    const skillsProfile = document.querySelector('#skills-profile');
    const approval = document.querySelector('#approval-policy');
    const start = document.querySelector('.new-session-button');
    const follows = (before: Element | null, after: Element | null) =>
      Boolean(
        before && after && before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    return {
      treeThenSkillsProfile: follows(tree, skillsProfile),
      skillsProfileThenSandbox: follows(skillsProfile, sandbox),
      sandboxThenApproval: follows(sandbox, approval),
      approvalThenStart: follows(approval, start),
    };
  });
  expect(order).toEqual({
    treeThenSkillsProfile: true,
    skillsProfileThenSandbox: true,
    sandboxThenApproval: true,
    approvalThenStart: true,
  });

  const treePanel = page.locator('.tree-panel');
  const sandbox = page.getByLabel('Sandbox');
  const [treeBox, sandboxBox] = await Promise.all([treePanel.boundingBox(), sandbox.boundingBox()]);
  expect(treeBox).not.toBeNull();
  expect(sandboxBox).not.toBeNull();
  expect(treeBox!.y + treeBox!.height).toBeLessThanOrEqual(sandboxBox!.y);

  const start = page.getByRole('button', { name: 'Create session' });
  await start.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expect(start).toBeVisible();
  const [startBox, navigationBox] = await Promise.all([
    start.boundingBox(),
    page.getByLabel('Primary').boundingBox(),
  ]);
  expect(startBox).not.toBeNull();
  expect(navigationBox).not.toBeNull();
  expect(startBox!.y + startBox!.height).toBeLessThanOrEqual(navigationBox!.y);
}

test('uses the same selected highlight for pointer and keyboard interaction', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = await openSessions(page, 'minimal-light', 100);
  await page.getByRole('button', { name: 'Expand mobile-applications-and-experiments' }).click();

  const repository = page.getByRole('treeitem', { name: /^gestalt-mobile/ });
  await repository.click();
  await expect(repository).toHaveAttribute('aria-selected', 'true');

  const intermediate = page.getByRole('treeitem', { name: /^mobile-applications/ });
  await intermediate.focus();
  await intermediate.press('Enter');
  await expect(intermediate).toHaveAttribute('aria-selected', 'true');
  await expect(repository).toHaveAttribute('aria-selected', 'false');

  await repository.click();
  await expect(repository).toHaveAttribute('aria-selected', 'true');
  expectCleanThemeDiagnostics(diagnostics);
});

for (const viewport of evidenceViewports) {
  for (const fontScale of evidenceFontScales) {
    for (const theme of evidenceThemes) {
      test(`captures Sessions tree at ${viewport.width}x${viewport.height}, ${fontScale}% font, ${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        const diagnostics = await openSessions(page, theme, fontScale);

        await page.getByRole('button', { name: 'Collapse dyne' }).click();
        await page.screenshot({
          path: `${evidenceDirectory}/${evidenceFilename('sessions', 'collapsed', viewport, fontScale, theme)}`,
          fullPage: false,
        });

        await page.getByRole('button', { name: 'Expand dyne' }).click();
        await page
          .getByRole('button', { name: 'Expand mobile-applications-and-experiments' })
          .click();
        const repository = page.getByRole('treeitem', { name: /^gestalt-mobile/ });
        await repository.click();
        await expect(repository).toHaveAttribute('aria-selected', 'true');
        await expectReadableSelection(repository);
        await expect(repository).toContainText('~/dyne/mobile-applications-and-experiments/');
        await expectUsableLayout(page);
        await repository.evaluate((element) => element.scrollIntoView({ block: 'center' }));
        await page.screenshot({
          path: `${evidenceDirectory}/${evidenceFilename('sessions', 'expanded-selected', viewport, fontScale, theme)}`,
          fullPage: false,
        });

        expectCleanThemeDiagnostics(diagnostics);
      });
    }
  }
}

test('keeps failure feedback readable without covering the selected path or controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const diagnostics = await openSessions(page, 'minimal-dark', 200);
  await page.getByRole('button', { name: 'Expand mobile-applications-and-experiments' }).click();
  const repository = page.getByRole('treeitem', { name: /^gestalt-mobile/ });
  await repository.click();
  await page.getByRole('button', { name: 'Create session' }).click();

  const toast = page.getByRole('alert');
  await expect(toast).toContainText('The session could not be started. Try again.');
  await expect(repository).toHaveAttribute('aria-selected', 'true');
  const [toastBox, startBox] = await Promise.all([
    toast.boundingBox(),
    page.getByRole('button', { name: 'Create session' }).boundingBox(),
  ]);
  expect(toastBox).not.toBeNull();
  expect(startBox).not.toBeNull();
  expect(
    toastBox!.y + toastBox!.height <= startBox!.y || startBox!.y + startBox!.height <= toastBox!.y,
    JSON.stringify({ toastBox, startBox }),
  ).toBe(true);
  await page.screenshot({
    path: `${evidenceDirectory}/sessions-320x568-font200-dark-failure-toast.png`,
    fullPage: false,
  });
  expect(diagnostics.requestFailures).toEqual([]);
  expect(diagnostics.consoleErrors).toEqual([
    'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
  ]);
});
