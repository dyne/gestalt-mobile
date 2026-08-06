/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { bootstrapTheme, selectTheme } from './browser-theme.js';

function dependencies(stored: string | null = null) {
  const root = document.createElement('html');
  const meta = document.createElement('meta');
  const writes: Array<[string, string]> = [];
  return {
    root,
    meta,
    writes,
    storage: { getItem: () => stored, setItem: (key: string, value: string) => writes.push([key, value]) },
  };
}

describe('browser theme boundary', () => {
  it.each([
    [null, 'dyne-org'], ['minimal-dark', 'minimal-dark'], ['light', 'minimal-light'], ['system', 'dyne-org'], ['retired', 'dyne-org'],
  ])('applies resolved stored theme %# before mount', (stored, expected) => {
    const browser = dependencies(stored);
    expect(bootstrapTheme(browser)).toBe(expected);
    expect(browser.root.dataset.theme).toBe(expected);
    expect(browser.root.dataset.logoTone).toBe(expected === 'minimal-dark' ? 'light' : 'dark');
    expect(browser.root.style.colorScheme).toBe(expected === 'minimal-dark' ? 'dark' : 'light');
    expect(browser.meta.content).toBe(expected === 'minimal-dark' ? 'dark' : 'light');
    expect(browser.writes).toEqual([]);
  });

  it('applies and persists an explicit selection', () => {
    const browser = dependencies();
    expect(selectTheme('minimal-dark', browser)).toBe('minimal-dark');
    expect(browser.writes).toEqual([['gestalt-mobile.theme', 'minimal-dark']]);
  });

  it('continues when storage is unavailable or throws', () => {
    const root = document.createElement('html');
    expect(bootstrapTheme({ root, meta: null, storage: null })).toBe('dyne-org');
    expect(selectTheme('minimal-light', {
      root,
      meta: null,
      storage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } },
    })).toBe('minimal-light');
  });
});
