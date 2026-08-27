/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ProfileCatalog } from '../../features/catalog/application/ports.js';
import type { RecentThread } from '../../features/sessions/list-recent-threads/endpoint.js';
import type { SessionExecutionPolicy } from '../../features/sessions/model/relay-session.js';
import { readRolloutExecutionPolicy } from './rollout-execution-policy.js';
import type { AppServer } from './session-runtime.js';

type ThreadListResult = {
  data?: Array<{ id?: unknown; cwd?: unknown; path?: unknown; recencyAt?: unknown }>;
};
type ListedRecentThread = RecentThread & { rolloutPath?: string };

export function createRecentThreadLister(deps: {
  root: string;
  profiles: Pick<ProfileCatalog, 'list'>;
  launch(input: { profile: string; cwd: string }): AppServer;
  readExecutionPolicy?: (rolloutPath: string) => Promise<SessionExecutionPolicy | undefined>;
}): {
  list(): Promise<RecentThread[]>;
  executionPolicy(threadId: string): Promise<SessionExecutionPolicy | undefined>;
} {
  const rolloutPaths = new Map<string, string>();
  const list = async (): Promise<RecentThread[]> => {
    const profiles = (await deps.profiles.list()).filter((profile) => profile.state === 'ok');
    const listed = await Promise.all(
      profiles.map(async ({ name }) => listProfileThreads(deps.launch, name, deps.root)),
    );
    const byId = new Map<string, ListedRecentThread>();
    for (const thread of listed.flat()) {
      const known = byId.get(thread.id);
      if (!known || (thread.recencyAt ?? 0) > (known.recencyAt ?? 0)) byId.set(thread.id, thread);
    }
    rolloutPaths.clear();
    return [...byId.values()]
      .sort((a, b) => (b.recencyAt ?? 0) - (a.recencyAt ?? 0))
      .map(({ rolloutPath, ...thread }) => {
        if (rolloutPath) rolloutPaths.set(thread.id, rolloutPath);
        return thread;
      });
  };
  return {
    list,
    executionPolicy: async (threadId) => {
      if (!rolloutPaths.has(threadId)) await list();
      const rolloutPath = rolloutPaths.get(threadId);
      return rolloutPath
        ? (deps.readExecutionPolicy ?? readRolloutExecutionPolicy)(rolloutPath)
        : undefined;
    },
  };
}

async function listProfileThreads(
  launch: (input: { profile: string; cwd: string }) => AppServer,
  profile: string,
  cwd: string,
): Promise<ListedRecentThread[]> {
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
      return [
        {
          id: thread.id,
          cwd: thread.cwd,
          profile,
          recencyAt: toRecency(thread.recencyAt),
          ...(typeof thread.path === 'string' ? { rolloutPath: thread.path } : {}),
        },
      ];
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
