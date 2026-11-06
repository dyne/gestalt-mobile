/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { defineConfig } from '@playwright/test';
import functional from './playwright.functional.config.js';

/** Small local-fixture protection set; the functional lane retains every case. */
export default defineConfig(functional, {
  grep: /@smoke/,
  forbidOnly: true,
  retries: 0,
  workers: 2,
  outputDir: `test-results/browser-smoke-${process.env.PLAYWRIGHT_OUTPUT_ID ?? 'local'}`,
  use: {
    screenshot: 'only-on-failure',
  },
});
