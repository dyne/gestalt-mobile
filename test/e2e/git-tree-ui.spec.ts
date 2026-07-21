/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';

const evidenceDirectory = '/tmp/gestalt-mobile-git-tree-evidence';
const viewports = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
] as const;
const themes = ['light', 'dark'] as const;
const fontScales = [100, 200] as const;

type Workspace = {
  id: string;
  name: string;
  relativePath: string;
  isGitRepository: boolean;
  children: Workspace[];
};

const repository = (id: string, name: string): Workspace => ({
  id,
  name,
  relativePath: `clients/2026/very-long-program-name/${name}`,
  isGitRepository: true,
  children: [],
});

function workspaceTree(cloned: boolean): Workspace[] {
  return [
    {
      id: 'root',
      name: 'development-workspace-with-a-very-long-name',
      relativePath: '.',
      isGitRepository: false,
      children: [
        {
          id: 'ordinary-destination',
          name: 'ordinary-clone-destination-with-a-long-name',
          relativePath: 'clients/2026/ordinary-clone-destination-with-a-long-name',
          isGitRepository: false,
          children: cloned
            ? [repository('cloned-repository', 'newly-cloned-responsive-repository')]
            : [],
        },
        {
          id: 'many-repositories',
          name: 'many-repository-siblings-fold-this-group',
          relativePath: 'clients/2026/many-repository-siblings-fold-this-group',
          isGitRepository: false,
          children: [
            repository('primary-repository', 'primary-repository-with-a-long-name'),
            ...Array.from({ length: 18 }, (_, index) =>
              repository(`sibling-${index + 1}`, `sibling-repository-${index + 1}`),
            ),
          ],
        },
      ],
    },
  ];
}

const summary = {
  available: true,
  branch: 'responsive-layout-verification-with-a-long-name',
  branches: ['responsive-layout-verification-with-a-long-name', 'main'],
  upstream: 'origin/responsive-layout-verification-with-a-long-name',
  ahead: 2,
  behind: 0,
  dirty: { staged: 3, unstaged: 4, untracked: 5 },
  commits: Array.from({ length: 8 }, (_, index) => ({
    hash: `${index + 1}`.repeat(40).slice(0, 40),
    shortHash: `${index + 1}`.repeat(7).slice(0, 7),
    subject: `Commit ${index + 1} with a deliberately long subject that must wrap safely`,
    author: 'Responsive Verification Author',
    authoredAt: '2026-07-21T08:00:00.000Z',
  })),
  fetchedAt: '2026-07-21T08:00:00.000Z',
};

type Diagnostics = { consoleErrors: string[]; requestFailures: string[] };

test.beforeAll(async () => mkdir(evidenceDirectory, { recursive: true }));

async function openGit(
  page: Page,
  theme: (typeof themes)[number],
  fontScale: (typeof fontScales)[number],
): Promise<Diagnostics> {
  const diagnostics: Diagnostics = { consoleErrors: [], requestFailures: [] };
  let cloned = false;
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => diagnostics.requestFailures.push(request.url()));
  await page.addInitScript(
    ({ selectedTheme }) => localStorage.setItem('gestalt-mobile.theme', selectedTheme),
    { selectedTheme: theme },
  );
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: workspaceTree(cloned),
        profiles: [{ name: 'default', state: 'ok', status: 'ready' }],
        sessions: [],
      }),
    }),
  );
  await page.route(/\/api\/git\/repositories\/[^/]+$/, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(summary) }),
  );
  await page.route('**/api/git/clone', async (route) => {
    cloned = true;
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/');
  await page.addStyleTag({ content: `html { font-size: ${fontScale}% !important; }` });
  await page.getByRole('button', { name: 'Git' }).click();
  await expect(
    page.getByRole('heading', { name: 'Repository and clone destination' }),
  ).toBeVisible();
  return diagnostics;
}

async function expectUsableLayout(page: Page): Promise<void> {
  const layout = await page.evaluate(() => {
    const tree = document.querySelector<HTMLElement>('[role="tree"]');
    const gitTree = document.querySelector<HTMLElement>('.git-tree');
    const clone = document.querySelector<HTMLElement>('.clone-form');
    const details = document.querySelector<HTMLElement>('.repository-details');
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')].map((button) => {
      const box = button.getBoundingClientRect();
      return {
        name: button.getAttribute('aria-label') ?? button.textContent?.trim(),
        width: box.width,
        height: box.height,
      };
    });
    const offenders = [...document.querySelectorAll<HTMLElement>('body *')]
      .map((element) => ({
        name: `${element.tagName.toLowerCase()}.${element.className}`,
        box: element.getBoundingClientRect().toJSON(),
      }))
      .filter(
        ({ box }) => box.left < -0.5 || box.right > document.documentElement.clientWidth + 0.5,
      )
      .slice(0, 8);
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      treeOverflow: tree ? tree.scrollWidth - tree.clientWidth : 1,
      order:
        gitTree && clone && details
          ? {
              treeBottom: gitTree.offsetTop + gitTree.offsetHeight,
              cloneTop: clone.offsetTop,
              cloneBottom: clone.offsetTop + clone.offsetHeight,
              detailsTop: details.offsetTop,
            }
          : null,
      undersized: buttons.filter(({ width, height }) => width < 44 || height < 44),
      offenders,
    };
  });
  expect(layout.documentOverflow, JSON.stringify(layout)).toBe(0);
  expect(layout.treeOverflow).toBe(0);
  expect(layout.undersized, JSON.stringify(layout.undersized)).toEqual([]);
  expect(layout.offenders, JSON.stringify(layout.offenders)).toEqual([]);
  expect(layout.order).not.toBeNull();
  expect(layout.order!.treeBottom).toBeLessThanOrEqual(layout.order!.cloneTop);
  expect(layout.order!.cloneBottom).toBeLessThanOrEqual(layout.order!.detailsTop);
}

async function capture(
  page: Page,
  state: string,
  viewport: (typeof viewports)[number],
  fontScale: (typeof fontScales)[number],
  theme: (typeof themes)[number],
  focus: Locator,
  scrollBlock: ScrollLogicalPosition = 'center',
): Promise<void> {
  await focus.evaluate((element, block) => element.scrollIntoView({ block }), scrollBlock);
  await expect(focus).toBeVisible();
  await expectUsableLayout(page);
  await page.screenshot({
    path: `${evidenceDirectory}/git-${state}-${viewport.width}x${viewport.height}-font${fontScale}-${theme}.png`,
    fullPage: false,
  });
}

async function expectNoOverlap(first: Locator, second: Locator): Promise<void> {
  const [firstBox, secondBox] = await Promise.all([first.boundingBox(), second.boundingBox()]);
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  const overlaps = !(
    firstBox!.x + firstBox!.width <= secondBox!.x ||
    secondBox!.x + secondBox!.width <= firstBox!.x ||
    firstBox!.y + firstBox!.height <= secondBox!.y ||
    secondBox!.y + secondBox!.height <= firstBox!.y
  );
  expect(overlaps, JSON.stringify({ firstBox, secondBox })).toBe(false);
}

async function expectActionAboveNavigation(action: Locator, navigation: Locator): Promise<void> {
  await action.focus();
  await action.evaluate((element) => element.scrollIntoView({ block: 'end' }));
  const [actionBox, navigationBox] = await Promise.all([
    action.boundingBox(),
    navigation.boundingBox(),
  ]);
  expect(actionBox).not.toBeNull();
  expect(navigationBox).not.toBeNull();
  expect(actionBox!.y).toBeGreaterThanOrEqual(0);
  expect(
    actionBox!.y + actionBox!.height,
    JSON.stringify({ actionBox, navigationBox }),
  ).toBeLessThanOrEqual(navigationBox!.y);
}

for (const viewport of viewports) {
  for (const fontScale of fontScales) {
    for (const theme of themes) {
      test(`captures five Git states at ${viewport.width}x${viewport.height}, ${fontScale}% font, ${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        const diagnostics = await openGit(page, theme, fontScale);

        const ordinary = page.getByRole('treeitem', { name: /^ordinary-clone-destination/ });
        await ordinary.click();
        await expect(ordinary).toHaveAttribute('aria-selected', 'true');
        await expect(ordinary).toBeFocused();
        await expect(page.getByRole('button', { name: 'Clone' })).toBeEnabled();
        await expect(page.getByRole('button', { name: 'Push' })).toBeDisabled();
        await capture(page, 'ordinary-selected', viewport, fontScale, theme, ordinary);

        const primary = page.getByRole('treeitem', { name: /^primary-repository/ });
        await primary.click();
        await expect(primary).toHaveAttribute('aria-selected', 'true');
        await expect(primary).toBeFocused();
        await expect(primary).toContainText('Git');
        const pull = page.getByRole('button', { name: 'Pull' });
        await expect(pull).toBeEnabled();
        await capture(page, 'repository-selected', viewport, fontScale, theme, pull);

        const fold = page.getByRole('button', { name: 'Collapse many-repository-siblings' });
        const repositoryGroup = page.getByRole('treeitem', {
          name: /^many-repository-siblings/,
        });
        await fold.click();
        await expect(repositoryGroup).toHaveAttribute('aria-expanded', 'false');
        await expect(primary).toBeHidden();
        await capture(page, 'many-siblings-folded', viewport, fontScale, theme, repositoryGroup);

        await page.getByRole('button', { name: 'Expand many-repository-siblings' }).click();
        await primary.click();
        await page.getByLabel('Git address').fill('https://example.test/invalid-target.git');
        await page.getByRole('button', { name: 'Clone' }).click();
        const errorToast = page
          .getByLabel('Notifications')
          .getByRole('alert')
          .filter({ hasText: 'Select a non-repository folder before cloning.' });
        await expect(errorToast).toBeVisible();
        const cloneButton = page.getByRole('button', { name: 'Clone' });
        const navigation = page.getByLabel('Primary');
        await expectActionAboveNavigation(cloneButton, navigation);
        await expectNoOverlap(errorToast, cloneButton);
        await expectNoOverlap(errorToast, navigation);
        await capture(page, 'clone-error-toast', viewport, fontScale, theme, cloneButton, 'end');
        await errorToast.getByRole('button', { name: 'Dismiss error notification' }).click();

        await ordinary.click();
        await page
          .getByLabel('Git address')
          .fill('https://example.test/newly-cloned-responsive-repository.git');
        await page.getByRole('button', { name: 'Clone' }).click();
        const successToast = page
          .getByLabel('Notifications')
          .getByRole('status')
          .filter({ hasText: 'Repository cloned.' });
        await expect(successToast).toBeVisible();
        const clonedRepository = page.getByRole('treeitem', {
          name: /^newly-cloned-responsive-repository/,
        });
        await expect(clonedRepository).toHaveAttribute('aria-selected', 'true');
        await expectNoOverlap(successToast, page.getByLabel('Primary'));
        await capture(page, 'clone-success', viewport, fontScale, theme, clonedRepository);

        expect(diagnostics).toEqual({ consoleErrors: [], requestFailures: [] });
      });
    }
  }
}
