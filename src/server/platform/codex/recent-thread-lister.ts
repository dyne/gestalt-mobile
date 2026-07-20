/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ProfileCatalog } from '../../features/catalog/application/ports.js';
import type { RecentThread } from '../../features/sessions/list-recent-threads/endpoint.js';
import type { AppServer } from './session-runtime.js';

type ThreadListResult = {
  data?: Array<{ id?: unknown; cwd?: unknown; recencyAt?: unknown }>;
};

export function createRecentThreadLister(deps: {
  root: string;
  profiles: Pick<ProfileCatalog, 'list'>;
  launch(input: { profile: string; cwd: string }): AppServer;
}): { list(): Promise<RecentThread[]> } {
  return {
    async list() {
      const profiles = (await deps.profiles.list()).filter((profile) => profile.state === 'ok');
      const listed = await Promise.all(
        profiles.map(async ({ name }) => listProfileThreads(deps.launch, name, deps.root)),
      );
      const byId = new Map<string, RecentThread>();
      for (const thread of listed.flat()) {
        const known = byId.get(thread.id);
        if (!known || (thread.recencyAt ?? 0) > (known.recencyAt ?? 0)) byId.set(thread.id, thread);
      }
      return [...byId.values()].sort((a, b) => (b.recencyAt ?? 0) - (a.recencyAt ?? 0));
    },
  };
}

async function listProfileThreads(
  launch: (input: { profile: string; cwd: string }) => AppServer,
  profile: string,
  cwd: string,
): Promise<RecentThread[]> {
  const process = launch({ profile, cwd });
  try {
    await process.rpc.request('initialize', {
      clientInfo: { name: 'gestalt-mobile', version: '0.1.0' },
      capabilities: null,
    });
    const result = (await process.rpc.request('thread/list', {
      limit: 20,
      sortKey: 'recency_at',
      sortDirection: 'desc',
      sourceKinds: ['cli', 'appServer'],
    })) as ThreadListResult;
    return (result.data ?? []).flatMap((thread) => {
      if (typeof thread.id !== 'string' || typeof thread.cwd !== 'string') return [];
      return [{ id: thread.id, cwd: thread.cwd, profile, recencyAt: toRecency(thread.recencyAt) }];
    });
  } catch {
    return [];
  } finally {
    process.close();
  }
}

function toRecency(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
