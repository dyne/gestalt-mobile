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

function browserDependencies(dependencies: ThemeBrowserDependencies): Required<Pick<ThemeBrowserDependencies, 'root' | 'storage'>> & ThemeBrowserDependencies {
  return {
    ...dependencies,
    root: dependencies.root ?? document.documentElement,
    storage: dependencies.storage ?? window.localStorage,
  };
}

export function applyTheme(id: ThemeId, dependencies: ThemeBrowserDependencies = {}): ThemeId {
  const { root, meta } = browserDependencies(dependencies);
  const theme = themeById(id);
  root.dataset.theme = theme.id;
  root.dataset.logoTone = theme.logoTone;
  root.style.colorScheme = theme.colorScheme;
  if (meta) meta.content = theme.colorScheme;
  return theme.id;
}

export function bootstrapTheme(dependencies: ThemeBrowserDependencies = {}): ThemeId {
  const resolved = resolveStoredTheme(storageValue(browserDependencies(dependencies).storage));
  return applyTheme(resolved, dependencies);
}

export function selectTheme(id: ThemeId, dependencies: ThemeBrowserDependencies = {}): ThemeId {
  const resolved = applyTheme(id, dependencies);
  try {
    browserDependencies(dependencies).storage?.setItem(THEME_STORAGE_KEY, resolved);
  } catch {
    // Storage is optional: applying the choice is still useful for this page.
  }
  return resolved;
}
