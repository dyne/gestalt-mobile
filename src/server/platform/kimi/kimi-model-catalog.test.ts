/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { KimiModelCatalog } from './kimi-model-catalog.js';
import type { KimiWebServerManager } from './kimi-web-server-manager.js';

function managerWith(models: unknown): KimiWebServerManager {
  return {
    ensure: async () => ({
      client: { get: async () => models },
    }),
  } as unknown as KimiWebServerManager;
}

describe('KimiModelCatalog', () => {
  it('returns an empty list when kimi is unavailable', async () => {
    const catalog = new KimiModelCatalog(null, false);
    expect(await catalog.list()).toEqual([]);
  });

  it('lists sorted unique model aliases from the running server', async () => {
    const catalog = new KimiModelCatalog(
      managerWith({
        items: [
          { provider: 'kimi', model: 'k2' },
          { provider: 'kimi', model: 'k1' },
          { provider: 'kimi', model: 'k2' },
          { provider: 'kimi' },
          { provider: 'kimi', model: '' },
          { provider: 'kimi', model: 'x'.repeat(200) },
        ],
      }),
      true,
    );
    expect(await catalog.list()).toEqual(['k1', 'k2']);
  });

  it('degrades to an empty list when the server call fails', async () => {
    const failing = {
      ensure: async () => ({
        client: {
          get: async () => {
            throw new Error('down');
          },
        },
      }),
    } as unknown as KimiWebServerManager;
    expect(await new KimiModelCatalog(failing, true).list()).toEqual([]);
  });
});
