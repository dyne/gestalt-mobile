/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

type SessionStoragePort = Pick<Storage, 'getItem' | 'setItem'>;

/** Session-persistent, bounded request-ID dedupe for replay-safe attention toasts. */
export function createAttentionToastDedupe(
  storage: SessionStoragePort | null,
  key = 'gestalt-mobile.autopilot-attention-toasts.v1',
  limit = 100,
) {
  let ids = read(storage, key, limit);
  return {
    claim(id: string): boolean {
      if (ids.has(id)) return false;
      ids = new Set([...ids, id].slice(-limit));
      try {
        storage?.setItem(key, JSON.stringify([...ids]));
      } catch {
        /* Toast dedupe remains in-memory when session storage is unavailable. */
      }
      return true;
    },
  };
}

function read(storage: SessionStoragePort | null, key: string, limit: number): Set<string> {
  try {
    const value = JSON.parse(storage?.getItem(key) ?? '[]');
    return new Set(
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string').slice(-limit)
        : [],
    );
  } catch {
    return new Set();
  }
}
