/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { CodexProfileCatalog } from './codex-profile-catalog.js';

describe('CodexProfileCatalog', () => {
  it('maps valid codex-profile status JSON without leaking homes', async () => {
    const catalog = new CodexProfileCatalog(async () =>
      JSON.stringify({
        profiles: [{ name: 'default', home: '/private', state: 'ok', status: 'ready' }],
      }),
    );
    await expect(catalog.list()).resolves.toEqual([
      { name: 'default', state: 'ok', status: 'ready' },
    ]);
  });

  it('offers the direct default home when no managed profile exists', async () => {
    const catalog = new CodexProfileCatalog(
      async () => JSON.stringify({ profiles: [] }),
      () => true,
    );
    await expect(catalog.list()).resolves.toEqual([
      { name: 'default', state: 'ok', status: 'Using ~/.codex' },
    ]);
  });
});
