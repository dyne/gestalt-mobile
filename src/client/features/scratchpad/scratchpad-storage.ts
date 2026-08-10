/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const SCRATCHPAD_STORAGE_KEY = 'gestalt-mobile.scratchpad';

export type ScratchpadStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function browserScratchpadStorage(): ScratchpadStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readScratchpad(storage: ScratchpadStorage | null): string {
  try {
    return storage?.getItem(SCRATCHPAD_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeScratchpad(storage: ScratchpadStorage | null, value: string): boolean {
  try {
    if (!storage) return false;
    storage.setItem(SCRATCHPAD_STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}

export function clearScratchpad(storage: ScratchpadStorage | null): boolean {
  try {
    if (!storage) return false;
    storage.removeItem(SCRATCHPAD_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
