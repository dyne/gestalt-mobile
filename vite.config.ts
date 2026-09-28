/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  ...(process.env.GESTALT_DEV_PROXY === '1'
    ? {
        server: {
          proxy: {
            '/api': { target: 'http://127.0.0.1:3001', ws: true },
          },
        },
      }
    : {}),
  // Local font files must stay external so the relay's strict CSP can permit them.
  build: { outDir: 'dist/client', emptyOutDir: true, assetsInlineLimit: 0 },
});
