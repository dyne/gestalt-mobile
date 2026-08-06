/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import {
  resolveStoredTheme,
  THEME_STORAGE_KEY,
  themeById,
  type ThemeId,
} from './theme-registry.js';

type ThemeRoot = Pick<HTMLElement, 'dataset' | 'style'>;
type ColorSchemeMeta = Pick<HTMLMetaElement, 'content'>;
type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface ThemeBrowserDependencies {
  root?: ThemeRoot;
  meta?: ColorSchemeMeta | null;
  storage?: ThemeStorage | null;
}

function storageValue(storage: ThemeStorage | null | undefined): string | null {
  try {
    return storage?.getItem(THEME_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function browserStorage(dependencies: ThemeBrowserDependencies): ThemeStorage | null {
  if ('storage' in dependencies) return dependencies.storage ?? null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function colorSchemeMeta(dependencies: ThemeBrowserDependencies): ColorSchemeMeta | null {
  if ('meta' in dependencies) return dependencies.meta ?? null;
  return document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
}

export function applyTheme(id: ThemeId, dependencies: ThemeBrowserDependencies = {}): ThemeId {
  const root = dependencies.root ?? document.documentElement;
  const meta = colorSchemeMeta(dependencies);
  const theme = themeById(id);
  root.dataset.theme = theme.id;
  root.dataset.logoTone = theme.logoTone;
  root.style.colorScheme = theme.colorScheme;
  if (meta) meta.content = theme.colorScheme;
  return theme.id;
}

export function bootstrapTheme(dependencies: ThemeBrowserDependencies = {}): ThemeId {
  const resolved = resolveStoredTheme(storageValue(browserStorage(dependencies)));
  return applyTheme(resolved, dependencies);
}

export function selectTheme(id: ThemeId, dependencies: ThemeBrowserDependencies = {}): ThemeId {
  const resolved = applyTheme(id, dependencies);
  try {
    browserStorage(dependencies)?.setItem(THEME_STORAGE_KEY, resolved);
  } catch {
    // Storage is optional: applying the choice is still useful for this page.
  }
  return resolved;
}
