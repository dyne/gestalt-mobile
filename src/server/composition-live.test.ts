/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, it } from 'vitest';
import { composeRelayApp } from './composition.js';

it('refuses production Live without its owning runtime before reading configuration or electing', async () => {
  for (const startAppServers of [undefined, false]) {
    await expect(
      composeRelayApp({
        root: '/configuration-must-not-be-read',
        installedCodexVersion: null,
        profiles: {
          list: async () => {
            throw new Error('PROFILE_ACCESS_FORBIDDEN');
          },
          require: async () => {
            throw new Error('PROFILE_ACCESS_FORBIDDEN');
          },
        },
        liveConfigFile: '/configuration-must-not-be-read/live.json',
        relyingParty: {
          publicOrigin: 'https://mobile.test',
          rpId: 'mobile.test',
          rpName: 'Gestalt Mobile',
        },
        startAppServers,
      }),
    ).rejects.toMatchObject({
      message: 'LIVE_DEPENDENCIES_UNAVAILABLE',
      liveDependency: 'owning-runtime-disabled',
    });
  }
});
