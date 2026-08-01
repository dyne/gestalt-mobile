/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RecentSession, RelaySession } from './relay-client.js';

export function managedSessionDetails(session: {
  threadId?: string | null;
  workspacePath?: string;
  updatedAt?: string;
}): { threadId: string | null; workspacePath: string; updatedAt: number | null } {
  const timestamp = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
  return {
    threadId: session.threadId ?? null,
    workspacePath: session.workspacePath ?? 'Workspace unavailable',
    updatedAt: Number.isFinite(timestamp) ? timestamp : null,
  };
}

export function retainForgottenSession(
  recentSessions: RecentSession[],
  forgottenSession: RelaySession | undefined,
): RecentSession[] {
  if (
    !forgottenSession?.threadId ||
    !forgottenSession.workspacePath ||
    !forgottenSession.resumeCommand ||
    recentSessions.some((session) => session.id === forgottenSession.threadId)
  ) {
    return recentSessions;
  }

  const updatedAt = forgottenSession.updatedAt
    ? Date.parse(forgottenSession.updatedAt) / 1_000
    : Number.NaN;
  const fallback: RecentSession = {
    id: forgottenSession.threadId,
    cwd: forgottenSession.workspacePath,
    recencyAt: Number.isFinite(updatedAt) ? updatedAt : null,
    resumeCommand: forgottenSession.resumeCommand,
  };

  return [...recentSessions, fallback].sort(
    (left, right) => (right.recencyAt ?? Number.NEGATIVE_INFINITY) - (left.recencyAt ?? Number.NEGATIVE_INFINITY),
  );
}

export function displayWorkspacePath(path: string): string {
  const homeDirectory = /^\/home\/[^/]+/.exec(path)?.[0];
  if (!homeDirectory) return path;
  const remainder = path.slice(homeDirectory.length);
  return remainder ? `~${remainder}` : '~/';
}
