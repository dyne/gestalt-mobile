/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { Page } from '@playwright/test';

/** Installs the current public auth-status contract before a legacy UI fixture navigates. */
export async function mockAuthenticatedStatus(page: Page): Promise<void> {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: 'authenticated', publicOrigin: 'http://127.0.0.1:4173' }),
    }),
  );
}
