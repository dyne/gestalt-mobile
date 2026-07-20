/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

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

export function displayWorkspacePath(path: string): string {
  const homeDirectory = /^\/home\/[^/]+/.exec(path)?.[0];
  if (!homeDirectory) return path;
  const remainder = path.slice(homeDirectory.length);
  return remainder ? `~${remainder}` : '~/';
}
