/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const evidenceDirectory = '/tmp/gestalt-mobile-sessions-tree-evidence';

test.beforeAll(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
});

const viewports = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
] as const;
const themes = ['light', 'dark'] as const;
const fontScales = [100, 200] as const;

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

type Diagnostics = { consoleErrors: string[]; requestFailures: string[] };

async function openSessions(
  page: Page,
  theme: (typeof themes)[number],
  fontScale: (typeof fontScales)[number],
): Promise<Diagnostics> {
  const diagnostics: Diagnostics = { consoleErrors: [], requestFailures: [] };
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
        workspaces: workspaceTree,
        profiles: [{ name: 'default', state: 'ok', status: 'ready' }],
        sessions: [],
      }),
    }),
  );
  await page.route('**/api/sessions/recent-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
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

  await page.goto('/');
  await page.addStyleTag({ content: `html { font-size: ${fontScale}% !important; }` });
  await expect(page.getByRole('tree', { name: 'Session base' })).toBeVisible();
  return diagnostics;
}

async function expectUsableLayout(page: Page): Promise<void> {
  const touchTargets = await page.locator('button').evaluateAll((buttons) =>
    buttons.map((button) => {
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
      return { left: box.left, right: box.right, width: box.width };
    });
    return {
      buttons,
      withinViewport: buttons.every(({ left, right }) => left >= 0 && right <= viewportWidth),
      nonOverlapping: buttons.every(
        ({ right }, index) => index === buttons.length - 1 || right <= buttons[index + 1]!.left,
      ),
    };
  });
  expect(navigationLayout.withinViewport, JSON.stringify(navigationLayout.buttons)).toBe(true);
  expect(navigationLayout.nonOverlapping, JSON.stringify(navigationLayout.buttons)).toBe(true);
  expect(navigationLayout.buttons).toHaveLength(3);
  expect(
    Math.max(...navigationLayout.buttons.map(({ width }) => width)) -
      Math.min(...navigationLayout.buttons.map(({ width }) => width)),
  ).toBeLessThanOrEqual(1);

  const order = await page.evaluate(() => {
    const tree = document.querySelector('[role="tree"]');
    const sandbox = document.querySelector('#sandbox');
    const approval = document.querySelector('#approval-policy');
    const start = document.querySelector('.new-session-button');
    const follows = (before: Element | null, after: Element | null) =>
      Boolean(
        before && after && before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    return {
      treeThenSandbox: follows(tree, sandbox),
      sandboxThenApproval: follows(sandbox, approval),
      approvalThenStart: follows(approval, start),
    };
  });
  expect(order).toEqual({
    treeThenSandbox: true,
    sandboxThenApproval: true,
    approvalThenStart: true,
  });

  const treePanel = page.locator('.tree-panel');
  const sandbox = page.getByLabel('Sandbox');
  const [treeBox, sandboxBox] = await Promise.all([treePanel.boundingBox(), sandbox.boundingBox()]);
  expect(treeBox).not.toBeNull();
  expect(sandboxBox).not.toBeNull();
  expect(treeBox!.y + treeBox!.height).toBeLessThanOrEqual(sandboxBox!.y);

  const start = page.getByRole('button', { name: 'New session' });
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
  const diagnostics = await openSessions(page, 'light', 100);
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
  expect(diagnostics).toEqual({ consoleErrors: [], requestFailures: [] });
});

for (const viewport of viewports) {
  for (const fontScale of fontScales) {
    for (const theme of themes) {
      test(`captures Sessions tree at ${viewport.width}x${viewport.height}, ${fontScale}% font, ${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        const diagnostics = await openSessions(page, theme, fontScale);

        await page.getByRole('button', { name: 'Collapse dyne' }).click();
        await page.screenshot({
          path: `${evidenceDirectory}/sessions-${viewport.width}x${viewport.height}-font${fontScale}-${theme}-collapsed.png`,
          fullPage: false,
        });

        await page.getByRole('button', { name: 'Expand dyne' }).click();
        await page
          .getByRole('button', { name: 'Expand mobile-applications-and-experiments' })
          .click();
        const repository = page.getByRole('treeitem', { name: /^gestalt-mobile/ });
        await repository.click();
        await expect(repository).toHaveAttribute('aria-selected', 'true');
        await expect(repository).toContainText('~/dyne/mobile-applications-and-experiments/');
        await expectUsableLayout(page);
        await repository.evaluate((element) => element.scrollIntoView({ block: 'center' }));
        await page.screenshot({
          path: `${evidenceDirectory}/sessions-${viewport.width}x${viewport.height}-font${fontScale}-${theme}-expanded-selected.png`,
          fullPage: false,
        });

        expect(diagnostics).toEqual({ consoleErrors: [], requestFailures: [] });
      });
    }
  }
}

test('keeps failure feedback readable without covering the selected path or controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const diagnostics = await openSessions(page, 'dark', 200);
  await page.getByRole('button', { name: 'Expand mobile-applications-and-experiments' }).click();
  const repository = page.getByRole('treeitem', { name: /^gestalt-mobile/ });
  await repository.click();
  await page.getByRole('button', { name: 'New session' }).click();

  const toast = page.getByRole('alert');
  await expect(toast).toContainText('The session could not be started. Try again.');
  await expect(repository).toHaveAttribute('aria-selected', 'true');
  const [toastBox, startBox] = await Promise.all([
    toast.boundingBox(),
    page.getByRole('button', { name: 'New session' }).boundingBox(),
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
