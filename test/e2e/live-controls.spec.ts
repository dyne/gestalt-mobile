/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture, deferred } from './chat-relay-fixture.js';
import { exchangeDocument } from '../../src/server/platform/live-design/exchange-document.js';

const evidence = process.env.LIVE_EVIDENCE_DIR;
const run = { liveId: 'live-1', generation: 1, state: 'active' };

async function install(page: Page, mode: 'ready' | 'active' | 'unavailable' | 'busy' = 'ready') {
  await mockAuthenticatedStatus(page);
  const fixture = new ChatRelayFixture(page);
  await fixture.install([
    {
      id: 'session-1',
      state: 'ready',
      workspacePath: '/workspace/app',
      provider: 'codex',
      model: 'gpt-6.1-sol',
      activeTurnId: null,
    },
  ]);
  let current = mode === 'active';
  const starts: unknown[] = [];
  const gate = deferred<void>();
  await page.route('**/api/sessions/session-1/live/targets', (route) =>
    route.fulfill({
      status: mode === 'unavailable' ? 404 : 200,
      json: { targets: [{ appId: 'website', targetId: 'development' }] },
    }),
  );
  await page.route('**/api/sessions/session-1/live', (route) =>
    route.fulfill({
      status: current ? 200 : 404,
      json: current ? run : { code: 'LIVE_NOT_FOUND' },
    }),
  );
  await page.route('**/api/sessions/session-1/live/start', async (route) => {
    starts.push(route.request().postDataJSON());
    if (mode === 'busy') return route.fulfill({ status: 409, json: { code: 'LIVE_SESSION_BUSY' } });
    await gate.promise;
    current = true;
    await route.fulfill({ json: run });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByRole('button', { name: 'Live controls', exact: true }).click();
  return { starts, gate };
}

test('keyboard discovery, unavailable setup guidance and busy toast', async ({ page }) => {
  await install(page, 'unavailable');
  await expect(page.getByRole('button', { name: 'Start Live', exact: true })).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'Live needs' })).toContainText('Caddy');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Live controls', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Close Live controls' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close Live controls' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Live controls', exact: true })).toBeFocused();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await install(page, 'busy');
  await page.getByRole('button', { name: 'Start Live', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('This session is busy');
});

test('authenticated fragment handshake reaches preview and blocked popups can retry', async ({
  page,
  context,
}) => {
  await install(page, 'active');
  const grant = 'a'.repeat(43);
  let challenge = '';
  let exchangeCount = 0;
  await page.route('**/api/sessions/session-1/live/launch-grants', async (route) => {
    const body = route.request().postDataJSON();
    expect(body).toEqual({
      liveId: 'live-1',
      generation: 1,
      codeChallenge: expect.any(String),
      codeChallengeMethod: 'S256',
    });
    challenge = body.codeChallenge;
    await route.fulfill({
      status: 201,
      json: { grantId: 'grant-1', grant, previewOrigin: 'https://preview.example.test' },
    });
  });
  const document = exchangeDocument('http://127.0.0.1:4173');
  await context.route('https://preview.example.test/**', async (route) => {
    const url = new URL(route.request().url());
    expect(url.search).toBe('');
    if (url.pathname === '/__gestalt_live/auth')
      return route.fulfill({
        contentType: 'text/html',
        headers: { 'content-security-policy': document.csp },
        body: document.html,
      });
    if (url.pathname === '/__gestalt_live/exchange') {
      const body = route.request().postDataJSON();
      expect(body.grant).toBe(grant);
      expect(createHash('sha256').update(body.codeVerifier).digest('base64url')).toBe(challenge);
      exchangeCount++;
      return route.fulfill({ status: 201, json: run });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: '<main><h1>Live preview fixture</h1><button>Pick an element</button></main>',
    });
  });
  await page.evaluate(() => {
    const original = window.open;
    window.open = () => null;
    Object.assign(window, {
      restoreLiveOpen: () => {
        window.open = original;
      },
    });
  });
  await page.getByRole('button', { name: 'Open preview', exact: true }).click();
  await expect(page.getByText(/Allow pop-ups for Mobile in your browser/)).toBeVisible();
  await page.evaluate(() => (window as unknown as { restoreLiveOpen(): void }).restoreLiveOpen());
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open preview', exact: true }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole('button', { name: 'Pick an element' })).toBeVisible();
  expect(exchangeCount).toBe(1);
  await expect(page.locator('body')).not.toContainText(grant);
  expect(popup.url()).toBe('https://preview.example.test/');
  expect(await popup.evaluate(() => window.opener)).toBe(null);
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  for (const scale of [100, 200]) {
    test(`ready starting active ${viewport.width}x${viewport.height} font ${scale}%`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const { gate, starts } = await install(page);
      await page.addStyleTag({ content: `html { font-size: ${scale}% !important; }` });
      const capture = async (state: string) => {
        const panel = page
          .getByRole('button', { name: 'Close Live controls' })
          .locator('..')
          .locator('..');
        await expect(panel).toBeVisible();
        expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        const bounds = await panel.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
        const header = page.locator('.app-header');
        expect(await header.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        if (evidence) {
          await mkdir(evidence, { recursive: true });
          await page.screenshot({
            path: `${evidence}/live-${state}-${viewport.width}x${viewport.height}-${scale}.png`,
          });
        }
      };
      await expect(page.getByRole('button', { name: 'Start Live', exact: true })).toBeEnabled();
      await capture('ready');
      await page.getByRole('button', { name: 'Start Live', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Starting Live…', exact: true }),
      ).toBeDisabled();
      await expect.poll(() => starts.length).toBe(1);
      await capture('starting');
      gate.resolve();
      await expect(page.getByRole('button', { name: 'Open preview', exact: true })).toBeVisible();
      await capture('active');
    });
  }
}
