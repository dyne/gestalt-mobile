/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RecentThread } from '../list-recent-threads/endpoint.js';
import {
  RelaySession,
  type RelaySessionSnapshot,
  type SessionExecutionPolicy,
} from '../model/relay-session.js';

export class RecentThreadHistoryUnavailable extends Error {
  constructor() {
    super('RECENT_THREAD_HISTORY_UNAVAILABLE');
  }
}
const inFlightPromotions = new Map<string, Promise<RelaySessionSnapshot>>();

export async function promoteRecentThread(
  thread: RecentThread,
  deps: {
    createId(): string;
    now(): string;
    list(): RelaySessionSnapshot[];
    save(session: RelaySessionSnapshot): void;
    read(session: RelaySessionSnapshot): Promise<unknown>;
    executionPolicy?(thread: RecentThread): Promise<SessionExecutionPolicy | undefined>;
  },
): Promise<RelaySessionSnapshot> {
  const key = `${thread.profile}:${thread.cwd}:${thread.id}`;
  const ongoing = inFlightPromotions.get(key);
  if (ongoing) return ongoing;
  const operation = promote(thread, deps);
  inFlightPromotions.set(key, operation);
  try {
    return await operation;
  } finally {
    if (inFlightPromotions.get(key) === operation) inFlightPromotions.delete(key);
  }
}

async function promote(
  thread: RecentThread,
  deps: {
    createId(): string;
    now(): string;
    list(): RelaySessionSnapshot[];
    save(session: RelaySessionSnapshot): void;
    read(session: RelaySessionSnapshot): Promise<unknown>;
    executionPolicy?(thread: RecentThread): Promise<SessionExecutionPolicy | undefined>;
  },
): Promise<RelaySessionSnapshot> {
  const existing = deps.list().find((session) => session.threadId === thread.id);
  if (existing) {
    const executionPolicy = existing.executionPolicy
      ? undefined
      : await deps.executionPolicy?.(thread);
    const recovered = executionPolicy
      ? { ...existing, executionPolicy, updatedAt: deps.now() }
      : existing;
    try {
      await deps.read(recovered);
    } catch {
      throw new RecentThreadHistoryUnavailable();
    }
    if (recovered !== existing) deps.save(recovered);
    return recovered;
  }
  const now = deps.now();
  const executionPolicy = await deps.executionPolicy?.(thread);
  const imported =
    existing ??
    RelaySession.fromExistingThread({
      id: deps.createId(),
      workspaceId: thread.cwd,
      workspacePath: thread.cwd,
      profile: thread.profile,
      threadId: thread.id,
      ...(executionPolicy === undefined ? {} : { executionPolicy }),
      now,
    }).snapshot;
  // Validate first: an unavailable thread must never leave an imported stub.
  try {
    await deps.read(imported);
  } catch {
    throw new RecentThreadHistoryUnavailable();
  }
  deps.save(imported);
  return imported;
}
