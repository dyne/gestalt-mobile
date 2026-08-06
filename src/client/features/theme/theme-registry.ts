/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const THEME_STORAGE_KEY = 'gestalt-mobile.theme';
export const DEFAULT_THEME_ID = 'dyne-org' as const;

export const themes = [
  { id: 'dyne-org', label: 'Dyne.org', colorScheme: 'light', logoTone: 'dark' },
  { id: 'minimal-light', label: 'Minimal light', colorScheme: 'light', logoTone: 'dark' },
  { id: 'minimal-dark', label: 'Minimal dark', colorScheme: 'dark', logoTone: 'light' },
] as const;

export type Theme = (typeof themes)[number];
export type ThemeId = Theme['id'];
export type ThemeLogoTone = Theme['logoTone'];

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && themes.some((theme) => theme.id === value);
}

export function resolveStoredTheme(value: unknown): ThemeId {
  if (value === 'light') return 'minimal-light';
  if (value === 'dark') return 'minimal-dark';
  return isThemeId(value) ? value : DEFAULT_THEME_ID;
}

export function themeById(id: ThemeId): Theme {
  const theme = themes.find((candidate) => candidate.id === id);
  if (!theme) return exhaustiveThemeId(id as never);
  return theme;
}

function exhaustiveThemeId(value: never): never {
  throw new Error(`Unknown theme ID: ${value}`);
}
