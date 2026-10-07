/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import {
  evidenceFilename,
  evidenceConfigurations,
  evidenceFontScales,
  evidenceThemes,
  evidenceViewports,
  expectCleanThemeDiagnostics,
  openThemeEvidence,
} from './theme-evidence.js';

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
  originUrl: 'git@example.test:owner/responsive-repository.git',
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

async function openGit(
  page: Page,
  theme: (typeof evidenceThemes)[number],
  fontScale: (typeof evidenceFontScales)[number],
) {
  let cloned = false;
  await mockAuthenticatedStatus(page);
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
    if (route.request().postDataJSON().address.includes('invalid-target'))
      return route.fulfill({ status: 503, json: { code: 'GIT_CLONE_FAILED' } });
    cloned = true;
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
  });
  const diagnostics = await openThemeEvidence(page, { theme, fontScale, url: '/' });
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
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')]
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
          ) {
            return false;
          }
        }
        return true;
      })
      .map((button) => {
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
      treePanel: tree
        ? {
            overflowY: getComputedStyle(tree).overflowY,
            borderBlockStartWidth: getComputedStyle(tree).borderBlockStartWidth,
          }
        : null,
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
  expect(layout.treePanel).toEqual({
    overflowY: 'auto',
    borderBlockStartWidth: '1px',
  });
  expect(layout.undersized, JSON.stringify(layout.undersized)).toEqual([]);
  expect(layout.offenders, JSON.stringify(layout.offenders)).toEqual([]);
  expect(layout.order).not.toBeNull();
  expect(layout.order!.treeBottom).toBeLessThanOrEqual(layout.order!.cloneTop);
  expect(layout.order!.cloneBottom).toBeLessThanOrEqual(layout.order!.detailsTop);
}

async function capture(
  page: Page,
  state: string,
  viewport: (typeof evidenceViewports)[number],
  fontScale: (typeof evidenceFontScales)[number],
  theme: (typeof evidenceThemes)[number],
  focus: Locator,
  testInfo: TestInfo,
  scrollBlock: ScrollLogicalPosition = 'center',
): Promise<void> {
  await focus.evaluate((element, block) => element.scrollIntoView({ block }), scrollBlock);
  await expect(focus).toBeVisible();
  await expectUsableLayout(page);
  await page.screenshot({
    path: testInfo.outputPath(evidenceFilename('git', state, viewport, fontScale, theme)),
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

for (const { viewport, fontScale, theme } of evidenceConfigurations()) {
  test(`captures five Git states at ${viewport.width}x${viewport.height}, ${fontScale}% font, ${theme}`, async ({
    page,
  }, testInfo: TestInfo) => {
    await page.setViewportSize(viewport);
    const diagnostics = await openGit(page, theme, fontScale);

    const ordinary = page.getByRole('treeitem', { name: /^ordinary-clone-destination/ });
    await ordinary.click();
    await expect(ordinary).toHaveAttribute('aria-selected', 'true');
    await expect(ordinary).toBeFocused();
    await expect(page.getByRole('button', { name: 'Clone' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Push' })).toBeDisabled();
    await capture(page, 'ordinary-selected', viewport, fontScale, theme, ordinary, testInfo);

    const primary = page.getByRole('treeitem', { name: /^primary-repository/ });
    await primary.click();
    await expect(primary).toHaveAttribute('aria-selected', 'true');
    await expect(primary).toBeFocused();
    await expect(primary).toContainText('Git');
    const pull = page.getByRole('button', { name: 'Pull' });
    await expect(pull).toBeEnabled();
    await expect(page.getByLabel('Git address')).toHaveValue(summary.originUrl);
    await expect(page.getByRole('button', { name: 'Clone' })).toBeDisabled();
    const browse = page.getByRole('button', { name: 'Browse files' });
    const browseBox = await browse.boundingBox();
    const treeBox = await page.locator('.git-tree').boundingBox();
    expect(Math.abs(browseBox!.width - treeBox!.width)).toBeLessThan(2);
    expect(browseBox!.height).toBeGreaterThanOrEqual(56);
    expect(
      await page
        .getByRole('tree', { name: 'Git repository and clone destination' })
        .evaluate((tree) => tree.scrollHeight > tree.clientHeight),
    ).toBe(true);
    await capture(page, 'repository-selected', viewport, fontScale, theme, pull, testInfo);

    const fold = page.getByRole('button', { name: 'Collapse many-repository-siblings' });
    const repositoryGroup = page.getByRole('treeitem', {
      name: /^many-repository-siblings/,
    });
    await fold.click();
    await expect(repositoryGroup).toHaveAttribute('aria-expanded', 'false');
    await expect(primary).toBeHidden();
    await capture(
      page,
      'many-siblings-folded',
      viewport,
      fontScale,
      theme,
      repositoryGroup,
      testInfo,
    );

    await page.getByRole('button', { name: 'Expand many-repository-siblings' }).click();
    await ordinary.click();
    await page.getByLabel('Git address').fill('https://example.test/invalid-target.git');
    await page.getByRole('button', { name: 'Clone' }).click();
    const errorToast = page
      .getByLabel('Notifications')
      .getByRole('alert')
      .filter({ hasText: 'Clone failed.' });
    await expect(errorToast).toBeVisible();
    const cloneButton = page.getByRole('button', { name: 'Clone' });
    const navigation = page.getByLabel('Primary');
    await expectActionAboveNavigation(cloneButton, navigation);
    await expectNoOverlap(errorToast, cloneButton);
    await expectNoOverlap(errorToast, navigation);
    await capture(
      page,
      'clone-error-toast',
      viewport,
      fontScale,
      theme,
      cloneButton,
      testInfo,
      'end',
    );
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
    await capture(page, 'clone-success', viewport, fontScale, theme, clonedRepository, testInfo);

    expectCleanThemeDiagnostics(diagnostics);
  });
}

for (const width of [390, 1280]) {
  test(`publishes a branch to origin on first Push at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openGit(page, evidenceThemes[0]!, 100);
    let published = false;
    let pushes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/api\/git\/repositories\/primary-repository$/, (route) =>
      route.fulfill({
        json: {
          ...summary,
          branch: 'new-topic',
          branches: ['new-topic'],
          upstream: published ? 'origin/new-topic' : null,
          ahead: 0,
          behind: 0,
        },
      }),
    );
    await page.route('**/api/git/repositories/primary-repository/push', async (route) => {
      pushes += 1;
      await gate;
      published = true;
      await route.fulfill({ status: 202, json: { accepted: true } });
    });
    await page.getByRole('treeitem', { name: /^primary-repository/ }).click();
    const push = page.getByRole('button', { name: 'Push', exact: true });
    await expect(push).toBeEnabled();
    await push.click();
    await expect(page.getByRole('region', { name: 'Confirm push' })).toContainText(
      'Publish new-topic to origin and set its upstream?',
    );
    await page.getByRole('button', { name: 'Confirm push', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pushing…', exact: true })).toBeDisabled();
    release();
    await expect(page.getByText('Upstream: origin/new-topic', { exact: true })).toBeVisible();
    await expect(push).toBeDisabled();
    expect(pushes).toBe(1);
  });
}
