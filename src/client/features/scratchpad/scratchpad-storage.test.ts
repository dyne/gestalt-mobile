/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import {
  clearScratchpad,
  readScratchpad,
  SCRATCHPAD_STORAGE_KEY,
  writeScratchpad,
} from './scratchpad-storage.js';

describe('scratchpad storage', () => {
  it('round-trips and clears the device-local scratchpad', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };

    expect(writeScratchpad(storage, 'Useful fragment')).toBe(true);
    expect(values.get(SCRATCHPAD_STORAGE_KEY)).toBe('Useful fragment');
    expect(readScratchpad(storage)).toBe('Useful fragment');
    expect(clearScratchpad(storage)).toBe(true);
    expect(readScratchpad(storage)).toBe('');
  });

  it('degrades safely when browser storage is unavailable', () => {
    const unavailable = {
      getItem: vi.fn(() => {
        throw new Error('unavailable');
      }),
      setItem: vi.fn(() => {
        throw new Error('unavailable');
      }),
      removeItem: vi.fn(() => {
        throw new Error('unavailable');
      }),
    };

    expect(readScratchpad(unavailable)).toBe('');
    expect(writeScratchpad(unavailable, 'text')).toBe(false);
    expect(clearScratchpad(unavailable)).toBe(false);
    expect(writeScratchpad(null, 'text')).toBe(false);
  });
});
