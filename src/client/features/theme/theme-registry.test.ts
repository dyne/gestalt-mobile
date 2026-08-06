/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_THEME_ID, isThemeId, resolveStoredTheme, themes } from './theme-registry.js';

describe('theme registry', () => {
  it('publishes the exact stable ordered theme contract', () => {
    expect(themes).toEqual([
      { id: 'dyne-org', label: 'Dyne.org', colorScheme: 'light', logoTone: 'dark' },
      { id: 'minimal-light', label: 'Minimal light', colorScheme: 'light', logoTone: 'dark' },
      { id: 'minimal-dark', label: 'Minimal dark', colorScheme: 'dark', logoTone: 'light' },
    ]);
    expect(new Set(themes.map((theme) => theme.id)).size).toBe(themes.length);
    expect(DEFAULT_THEME_ID).toBe('dyne-org');
  });

  it.each([
    ['dyne-org', 'dyne-org'],
    ['minimal-light', 'minimal-light'],
    ['minimal-dark', 'minimal-dark'],
    ['light', 'minimal-light'],
    ['dark', 'minimal-dark'],
    ['system', 'dyne-org'],
    [null, 'dyne-org'],
    [undefined, 'dyne-org'],
    ['', 'dyne-org'],
    ['retired', 'dyne-org'],
    [{ id: 'minimal-dark' }, 'dyne-org'],
  ])('resolves stored value %# deterministically', (stored, expected) => {
    expect(resolveStoredTheme(stored)).toBe(expected);
  });

  it('guards every current ID and rejects legacy values', () => {
    expect(themes.every((theme) => isThemeId(theme.id))).toBe(true);
    expect(isThemeId('light')).toBe(false);
  });
});
