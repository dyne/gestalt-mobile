/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type SessionScratchContext = Readonly<{
  workspacePath: string;
  ownerId: string;
  directory: string;
  environment: Readonly<Record<string, string>>;
}>;

export type ServiceScratchLease = SessionScratchContext & {
  release(): Promise<void>;
};

/** The selected workspace and durable relay identity, never a command's cwd. */
export interface SessionScratch {
  allocate(
    session: Readonly<{ id: string; workspacePath: string }>,
  ): Promise<SessionScratchContext>;
  associateProviderThread(
    session: Readonly<{ id: string; workspacePath: string }>,
    provider: 'codex' | 'kimi',
    threadId: string,
  ): Promise<void>;
}
