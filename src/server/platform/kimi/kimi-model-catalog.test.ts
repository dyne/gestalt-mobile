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
    list: () => [
      {
        client: { get: async () => models },
      },
    ],
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

  it('does not start a Kimi server while reading the model catalog', async () => {
    let ensureCalls = 0;
    const manager = {
      list: () => [],
      ensure: async () => {
        ensureCalls += 1;
        throw new Error('bootstrap must not start Kimi');
      },
    } as unknown as KimiWebServerManager;

    expect(await new KimiModelCatalog(manager, true).list()).toEqual([]);
    expect(ensureCalls).toBe(0);
  });

  it('starts Kimi only for explicit session model resolution', async () => {
    let ensureCalls = 0;
    const manager = {
      list: () => [],
      ensure: async () => {
        ensureCalls += 1;
        return { client: { get: async () => ({ items: [{ model: 'k2-thinking' }] }) } };
      },
    } as unknown as KimiWebServerManager;
    const catalog = new KimiModelCatalog(manager, true);

    expect(await catalog.list()).toEqual([]);
    expect(await catalog.listForSession()).toEqual(['k2-thinking']);
    expect(ensureCalls).toBe(1);
  });

  it('degrades to an empty list when the server call fails', async () => {
    const failing = {
      list: () => [
        {
          client: {
            get: async () => {
              throw new Error('down');
            },
          },
        },
      ],
    } as unknown as KimiWebServerManager;
    expect(await new KimiModelCatalog(failing, true).list()).toEqual([]);
  });
});
