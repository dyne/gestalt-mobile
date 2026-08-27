/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { BrowserContext, Page } from '@playwright/test';

type AuthRouteHost = Pick<Page, 'route'> | Pick<BrowserContext, 'route'>;

/** Installs the current public auth-status contract before a legacy UI fixture navigates. */
export async function mockAuthenticatedStatus(host: AuthRouteHost): Promise<void> {
  await host.route('**/api/auth/status', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'authenticated',
        publicOrigin: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 4173}`,
      }),
    }),
  );
}
