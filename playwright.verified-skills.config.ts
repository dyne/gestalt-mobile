/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { defineConfig } from '@playwright/test';

const port = Number(process.env.VERIFIED_SKILLS_PORT ?? 4187);

/** Opt-in actual installed flow; uses an isolated server and native Codex, never a model turn. */
export default defineConfig({
  testDir: './test/e2e',
  testMatch: 'verified-skills-installed.qualification.ts',
  workers: 1,
  timeout: 180_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 390, height: 844 },
    trace: 'retain-on-failure',
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    },
  },
  webServer: {
    command: 'node --import tsx test/e2e/verified-skills-installed-server.ts',
    url: `http://127.0.0.1:${port}/health`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
