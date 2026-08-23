/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { defineConfig } from '@playwright/test';

import { browserEvidenceSpecs } from './scripts/test-lanes.mjs';

/** Browser assertions excluding the exhaustive visual-evidence files and real-auth journey. */
export default defineConfig({
  testDir: './test/e2e',
  testIgnore: ['real-auth-journey.spec.ts', ...browserEvidenceSpecs],
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run dev:client -- --host 127.0.0.1 --port 4173 --strictPort',
    port: 4173,
    reuseExistingServer: false,
  },
});
