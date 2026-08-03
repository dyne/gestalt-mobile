/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

async function virtualPasskey(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

async function openDeviceManagement(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open configuration' }).click();
  await page.getByRole('button', { name: 'Authorized devices' }).click();
  await expect(page.getByRole('heading', { name: 'Authorized devices' })).toBeVisible();
}

async function expectWebSocket(page: Page, expected: 'open' | 'closed'): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          new Promise<string>((resolve) => {
            const socket = new WebSocket(
              `${location.origin.replace('http', 'ws')}/api/sessions/websocket-session/events`,
            );
            socket.onopen = () => {
              socket.close();
              resolve('open');
            };
            socket.onerror = () => resolve('closed');
            socket.onclose = () => resolve('closed');
          }),
      ),
    )
    .toBe(expected);
}

test.describe('real SimpleWebAuthn browser journey', () => {
  test.describe.configure({ mode: 'serial' });

  test('uses discoverable virtual passkeys across the full named-device lifecycle', async ({
    browser,
  }) => {
    const first = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const firstPage = await first.newPage();
    const firstAuthenticator = await virtualPasskey(first, firstPage);
    await firstPage.goto('/');
    await expect(
      firstPage.getByRole('heading', { name: 'Authorize the first device' }),
    ).toBeVisible();
    await expect(firstPage.getByText(/Trust-on-first-use/)).toBeVisible();
    await firstPage.screenshot({ path: 'test-results/auth/real-first-enrollment.png' });
    expect((await firstPage.request.get('/api/bootstrap')).status()).toBe(401);
    await expectWebSocket(firstPage, 'closed');

    await firstPage.getByLabel('Device nickname').fill('Primary phone');
    await firstPage.getByRole('button', { name: 'Authorize this device' }).click();
    await expect(firstPage.getByRole('button', { name: 'Open configuration' })).toBeVisible();
    await expect(firstPage.getByText(/No route matches GET \/api\/skill-profiles/)).toHaveCount(0);
    expect(
      (
        await firstAuthenticator.cdp.send('WebAuthn.getCredentials', {
          authenticatorId: firstAuthenticator.authenticatorId,
        })
      ).credentials,
    ).toHaveLength(1);
    expect((await firstPage.request.get('/api/bootstrap')).status()).toBe(200);
    await expectWebSocket(firstPage, 'open');
    await firstPage.getByRole('button', { name: 'Open configuration' }).click();
    await firstPage.getByRole('button', { name: 'Lock Gestalt Mobile' }).click();
    await expect(firstPage.getByRole('heading', { name: 'Unlock relay' })).toBeVisible();
    await firstPage.screenshot({ path: 'test-results/auth/real-login.png' });
    await firstPage.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(firstPage.getByRole('button', { name: 'Open configuration' })).toBeVisible();

    await openDeviceManagement(firstPage);
    await firstPage.getByRole('button', { name: 'Create enrollment link' }).click();
    const handoff = await firstPage.getByLabel('Enrollment link').inputValue();
    expect(handoff).toMatch(/^http:\/\/localhost:4173\/#enroll=/);

    const second = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const secondPage = await second.newPage();
    await virtualPasskey(second, secondPage);
    await secondPage.goto(handoff);
    await expect(secondPage).toHaveURL('http://localhost:4173/');
    await expect(secondPage.getByRole('heading', { name: 'Authorize this device' })).toBeVisible();
    await secondPage.getByLabel('Device nickname').fill('Laptop');
    await secondPage.getByRole('button', { name: 'Authorize this device' }).click();
    await expect(secondPage.getByRole('button', { name: 'Open configuration' })).toBeVisible();

    await firstPage.reload();
    await openDeviceManagement(firstPage);
    await expect(firstPage.getByLabel('Nickname for Laptop')).toBeVisible();
    await firstPage.getByLabel('Nickname for Laptop').fill('Travel laptop');
    await firstPage.getByRole('button', { name: 'Rename' }).nth(1).click();
    await expect(firstPage.getByLabel('Nickname for Travel laptop')).toHaveValue('Travel laptop');
    await firstPage.evaluate(() => window.scrollTo(0, 0));
    await firstPage.screenshot({ path: 'test-results/auth/real-device-management.png' });

    await firstPage
      .getByLabel('Nickname for Travel laptop')
      .locator('xpath=ancestor::form')
      .getByRole('button', { name: 'Revoke' })
      .click();
    await firstPage.getByRole('button', { name: 'Revoke device' }).click();
    await secondPage.goto('/');
    await expect(secondPage.getByRole('heading', { name: 'Unlock relay' })).toBeVisible();
    await secondPage.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(secondPage.getByText(/We could not complete sign-in/)).toBeVisible();

    await firstPage.reload();
    await openDeviceManagement(firstPage);
    const lastDeviceRevoke = firstPage.getByRole('button', { name: 'Revoke' });
    await expect(lastDeviceRevoke).toBeDisabled();
    await expect(firstPage.getByText('At least one authorized device is required.')).toBeVisible();

    await second.close();
    await first.close();
  });
});
