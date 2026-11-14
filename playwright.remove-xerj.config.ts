/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { defineConfig } from '@playwright/test';
import { installedChrome } from './scripts/installed-chrome.js';

export default defineConfig({
  testDir: './test/e2e',
  testMatch: [
    'remove-xerj-visual.spec.ts',
    'retrieval-readiness.spec.ts',
    'serena-session.spec.ts',
    'mcp-startup-diagnostics.spec.ts',
    'configuration-width.spec.ts',
    'session-writer-access.spec.ts',
    'detached-chat.spec.ts',
    'upgrade.spec.ts',
    'session-start.spec.ts',
    'session-tmp-cleanup.spec.ts',
  ],
  outputDir: process.env.PLAYWRIGHT_RESULTS_DIR ?? 'test-results/remove-xerj',
  workers: 1,
  use: {
    ...installedChrome(),
    baseURL: 'http://127.0.0.1:42831',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:client -- --host 127.0.0.1 --port 42831 --strictPort',
    port: 42831,
    reuseExistingServer: false,
  },
});
