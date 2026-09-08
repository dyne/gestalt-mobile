/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { LauncherProfileCatalog } from './launcher-profile-catalog.js';

describe('LauncherProfileCatalog', () => {
  it('offers the launcher-established environment as the default profile', async () => {
    const catalog = new LauncherProfileCatalog();
    await expect(catalog.list()).resolves.toEqual([
      { name: 'default', state: 'ok', status: 'Using the Gestalt launcher environment' },
    ]);
    await expect(catalog.require('default')).resolves.toEqual({
      name: 'default',
      state: 'ok',
      status: 'Using the Gestalt launcher environment',
    });
    await expect(catalog.require('legacy')).rejects.toThrow('PROFILE_NOT_FOUND');
  });
});
