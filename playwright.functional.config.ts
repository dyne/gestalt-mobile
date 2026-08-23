/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { defineConfig } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
const outputId = process.env.PLAYWRIGHT_OUTPUT_ID ?? 'local';

/** Browser assertions, including orthogonal checks from evidence specs, excluding real auth. */
export default defineConfig({
  testDir: './test/e2e',
  testIgnore: 'real-auth-journey.spec.ts',
  outputDir: `test-results/browser-functional-${outputId}`,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  webServer: {
    command: `npm run dev:client -- --host 127.0.0.1 --port ${port} --strictPort`,
    port,
    reuseExistingServer: false,
  },
});
