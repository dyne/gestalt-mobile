/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { createKimiRecentSessionLister } from './kimi-recent-session-lister.js';
import type { KimiWebServerManager } from './kimi-web-server-manager.js';

function listerWith(
  serversByProfile: Record<string, unknown[]>,
): ReturnType<typeof createKimiRecentSessionLister> {
  const handles = Object.entries(serversByProfile).map(([profileKey, items]) => ({
    profileKey,
    client: {
      get: async (path: string) => {
        if (!path.startsWith('/api/v2/sessions')) throw new Error(`no route ${path}`);
        return { items };
      },
    },
  }));
  const servers = {
    list: () => handles,
  } as unknown as KimiWebServerManager;
  return createKimiRecentSessionLister({ servers, available: true });
}

describe('createKimiRecentSessionLister', () => {
  it('returns nothing when kimi is unavailable', async () => {
    const lister = createKimiRecentSessionLister({ servers: null, available: false });
    expect(await lister.list()).toEqual([]);
  });

  it('maps v2 sessions to recent threads with normalized recency', async () => {
    const lister = listerWith({
      default: [
        {
          id: 'session_1',
          workspace: { id: 'wd_a', cwd: '/repo' },
          meta: { title: 'One', updated_at: 1_750_000_000 },
        },
        {
          id: 'session_2',
          workspace: { id: 'wd_a', cwd: '/repo' },
          meta: { title: 'Two', updated_at: 1_750_000_000_123 },
        },
        { id: 'session_3', workspace: { id: 'wd_b', cwd: null }, meta: { updated_at: 1 } },
        { id: 4, workspace: { cwd: '/repo' } },
      ],
    });
    expect(await lister.list()).toEqual([
      {
        id: 'session_1',
        cwd: '/repo',
        profile: 'default',
        recencyAt: 1_750_000_000,
        provider: 'kimi',
      },
      {
        id: 'session_2',
        cwd: '/repo',
        profile: 'default',
        recencyAt: 1_750_000_000,
        provider: 'kimi',
      },
    ]);
  });

  it('merges sessions across every running profile server, newest first', async () => {
    const lister = listerWith({
      default: [
        {
          id: 'session_old',
          workspace: { cwd: '/repo' },
          meta: { updated_at: 1_750_000_000 },
        },
      ],
      'profile:9f86d08': [
        {
          id: 'session_new',
          workspace: { cwd: '/repo' },
          meta: { updated_at: 1_750_000_100 },
        },
      ],
    });
    expect(await lister.list()).toEqual([
      {
        id: 'session_new',
        cwd: '/repo',
        profile: 'profile:9f86d08',
        recencyAt: 1_750_000_100,
        provider: 'kimi',
      },
      {
        id: 'session_old',
        cwd: '/repo',
        profile: 'default',
        recencyAt: 1_750_000_000,
        provider: 'kimi',
      },
    ]);
  });

  it('returns nothing when the server call fails', async () => {
    const handle = {
      profileKey: 'default',
      client: {
        get: async () => {
          throw new Error('down');
        },
      },
    };
    const servers = {
      list: () => [handle],
    } as unknown as KimiWebServerManager;
    const lister = createKimiRecentSessionLister({ servers, available: true });
    expect(await lister.list()).toEqual([]);
  });
});
