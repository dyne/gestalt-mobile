/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RecentThread } from '../../features/sessions/list-recent-threads/endpoint.js';
import type { KimiWebServerManager } from './kimi-web-server-manager.js';

const LIST_PATH = '/api/v2/sessions?page_size=50&sort=meta.updated_at_desc';
const LIST_TIMEOUT_MS = 5_000;

type WireSession = {
  id?: unknown;
  workspace?: unknown;
  meta?: unknown;
};

/**
 * Lists recent kimi web sessions through a gestalt-owned server, for parity
 * with the codex recent-thread lister. kimi timestamps arrive as epoch
 * seconds (or, defensively, epoch millis), normalized to seconds.
 */
export function createKimiRecentSessionLister(deps: {
  servers: KimiWebServerManager | null;
  available: boolean;
}): { list(): Promise<RecentThread[]> } {
  return {
    async list(): Promise<RecentThread[]> {
      if (!deps.available || !deps.servers) return [];
      try {
        const handle = await deps.servers.ensure('default', []);
        const data = (await withTimeout(
          handle.client.get(LIST_PATH),
          LIST_TIMEOUT_MS,
          'kimi session list timed out',
        )) as { items?: unknown };
        const items = Array.isArray(data.items) ? data.items : [];
        return items.flatMap((item: WireSession) => {
          if (!item || typeof item !== 'object') return [];
          const workspace = item.workspace;
          const cwd =
            workspace && typeof workspace === 'object'
              ? (workspace as { cwd?: unknown }).cwd
              : undefined;
          if (typeof item.id !== 'string' || typeof cwd !== 'string' || !cwd.startsWith('/'))
            return [];
          const updatedAt =
            item.meta && typeof item.meta === 'object'
              ? (item.meta as { updated_at?: unknown }).updated_at
              : undefined;
          return [
            {
              id: item.id,
              cwd,
              profile: 'default',
              recencyAt: toEpochSeconds(updatedAt),
              provider: 'kimi' as const,
            },
          ];
        });
      } catch {
        return [];
      }
    },
  };
}

function toEpochSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  // Epoch millis are roughly 1e12+ today; seconds stay below 1e11 for decades.
  return value > 1e11 ? Math.floor(value / 1000) : Math.floor(value);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(message)), timeoutMs).unref(),
    ),
  ]);
}
