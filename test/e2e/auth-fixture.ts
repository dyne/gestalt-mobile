/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { BrowserContext, Page } from '@playwright/test';

type AuthRouteHost = Pick<Page, 'route'> | Pick<BrowserContext, 'route'>;

/** Installs the current public auth-status contract before a legacy UI fixture navigates. */
export async function mockAuthenticatedStatus(host: AuthRouteHost): Promise<void> {
  // Legacy fixtures model an older server; readiness scenarios override this route.
  await host.route('**/api/sessions/*/retrieval-readiness', (route) =>
    route.fulfill({ status: 404 }),
  );
  await host.route('**/api/codex/allowance', (route) =>
    route.fulfill({
      json: { weeklyRemainingPercent: null, weeklyResetsAt: null, resetsAvailable: null },
    }),
  );
  await host.route('**/api/session-defaults', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ defaults: null }),
    }),
  );
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
