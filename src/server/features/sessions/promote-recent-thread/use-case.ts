/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RecentThread } from '../list-recent-threads/endpoint.js';
import { RelaySession, type RelaySessionSnapshot } from '../model/relay-session.js';

export async function promoteRecentThread(
  thread: RecentThread,
  deps: {
    createId(): string;
    now(): string;
    list(): RelaySessionSnapshot[];
    save(session: RelaySessionSnapshot): void;
    restore(session: RelaySessionSnapshot): Promise<RelaySessionSnapshot>;
  },
): Promise<RelaySessionSnapshot> {
  const existing = deps.list().find((session) => session.threadId === thread.id);
  if (existing?.state === 'ready' || existing?.state === 'turnActive') return existing;
  const now = deps.now();
  const imported =
    existing ??
    RelaySession.fromExistingThread({
      id: deps.createId(),
      workspaceId: thread.cwd,
      workspacePath: thread.cwd,
      profile: thread.profile,
      threadId: thread.id,
      now,
    }).snapshot;
  if (!existing) deps.save(imported);
  const active = await deps.restore(imported);
  deps.save(active);
  return active;
}
