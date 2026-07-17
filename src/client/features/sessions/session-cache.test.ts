/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { createSessionCache } from './session-cache.js';

describe('session cache', () => {
  it('uses harmless defaults when IndexedDB is unavailable', async () => {
    const cache = createSessionCache(undefined);

    await cache.saveSelectedSession('session-1');
    await cache.saveDraft('session-1', 'keep this draft');
    await cache.saveCursor('session-1', 12);

    await expect(cache.readSelectedSession()).resolves.toBeNull();
    await expect(cache.readDraft('session-1')).resolves.toBe('');
    await expect(cache.readCursor('session-1')).resolves.toBe(0);
  });
});
