/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { createAttentionToastDedupe } from './attention-toast-dedupe.js';

describe('attention toast dedupe', () => {
  it('deduplicates bootstrap, replay, and a reload while accepting a new request', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const first = createAttentionToastDedupe(storage);
    expect(first.claim('session:a')).toBe(true);
    expect(first.claim('session:a')).toBe(false);
    const reloaded = createAttentionToastDedupe(storage);
    expect(reloaded.claim('session:a')).toBe(false);
    expect(reloaded.claim('session:b')).toBe(true);
  });
});
