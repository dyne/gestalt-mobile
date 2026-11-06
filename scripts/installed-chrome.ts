/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Use the operator's Chrome installation; never fall back to Playwright's browser cache. */
export function installedChrome(environment: NodeJS.ProcessEnv = process.env) {
  return {
    channel: 'chrome' as const,
    launchOptions: environment.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: environment.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  };
}
