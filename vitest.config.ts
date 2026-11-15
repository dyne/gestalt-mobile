/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  resolve: { conditions: ['browser'] },
  test: {
    environment: 'node',
    // Managed fixture descendants share a live owner's containment fence.
    // Keep every test, but do not make independent files contend for that fence.
    fileParallelism: process.env.GESTALT_SESSION_TMP_CONTEXT === undefined,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'scripts/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['json-summary'],
      reportsDirectory: 'coverage/vitest',
      all: true,
      include: ['src/**/*.ts', 'src/**/*.svelte'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
    },
  },
});
