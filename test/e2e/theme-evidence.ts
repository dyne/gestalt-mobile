/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, type Page } from '@playwright/test';

import {
  THEME_STORAGE_KEY,
  themes,
  type ThemeId,
} from '../../src/client/features/theme/theme-registry.js';

/** The browser evidence matrix is deliberately derived from the production registry. */
export const evidenceThemes: readonly ThemeId[] = themes.map((theme) => theme.id);
export const evidenceViewports = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
] as const;
export const evidenceFontScales = [100, 200] as const;

export type EvidenceViewport = (typeof evidenceViewports)[number];
export type EvidenceFontScale = (typeof evidenceFontScales)[number];
export type EvidenceDiagnostics = {
  consoleErrors: string[];
  requestFailures: string[];
  localAssetFailures: string[];
};

export function evidenceFilename(
  component: string,
  state: string,
  viewport: EvidenceViewport,
  fontScale: EvidenceFontScale,
  theme: ThemeId,
): string {
  return `${component}-${state}-${viewport.width}x${viewport.height}-font${fontScale}-${theme}.png`;
}

/** Install diagnostics and the selected theme before navigation, then apply the requested text scale. */
export async function openThemeEvidence(
  page: Page,
  options: { theme: ThemeId; fontScale: EvidenceFontScale; url: string },
): Promise<EvidenceDiagnostics> {
  const diagnostics: EvidenceDiagnostics = {
    consoleErrors: [],
    requestFailures: [],
    localAssetFailures: [],
  };
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => diagnostics.requestFailures.push(request.url()));
  page.on('response', (response) => {
    if (
      response.status() >= 400 &&
      /\/(?:assets\/.*\.(?:woff2?|ttf|otf|svg|png|webp)|.*(?:logo|brand).*(?:svg|png|webp))(?:\?|$)/i.test(
        response.url(),
      )
    ) {
      diagnostics.localAssetFailures.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.addInitScript(
    ({ storageKey, selectedTheme }) => localStorage.setItem(storageKey, selectedTheme),
    { storageKey: THEME_STORAGE_KEY, selectedTheme: options.theme },
  );
  await page.goto(options.url);
  await page.addStyleTag({ content: `html { font-size: ${options.fontScale}% !important; }` });
  return diagnostics;
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    amount: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    offenders: [...document.querySelectorAll<HTMLElement>('body *')]
      .map((element) => ({
        name: `${element.tagName.toLowerCase()}.${element.className}`,
        box: element.getBoundingClientRect().toJSON(),
      }))
      .filter(({ box }) => box.left < -0.5 || box.right > window.innerWidth + 0.5)
      .slice(0, 8),
  }));
  // Fixed native popovers can contribute scroll width without extending any rendered element.
  // Evidence rejects real off-viewport content, which is the user-visible overflow contract.
  expect(overflow.offenders, JSON.stringify(overflow)).toEqual([]);
}

export function expectCleanThemeDiagnostics(
  diagnostics: EvidenceDiagnostics,
  options: {
    expectedConsoleErrors?: readonly string[];
    expectedRequestFailures?: readonly string[];
  } = {},
): void {
  const expectedRequests = options.expectedRequestFailures ?? [];
  const expectedConsole = options.expectedConsoleErrors ?? [];
  expect({
    ...diagnostics,
    consoleErrors: diagnostics.consoleErrors.filter(
      (message) => !expectedConsole.includes(message),
    ),
    requestFailures: diagnostics.requestFailures.filter((url) => !expectedRequests.includes(url)),
  }).toEqual({ consoleErrors: [], requestFailures: [], localAssetFailures: [] });
}
