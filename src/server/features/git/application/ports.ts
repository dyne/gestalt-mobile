/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type GitWorkspace = {
  id: string;
  path: string;
  isGitRepository: boolean;
};

export interface GitWorkspaceResolver {
  resolveGitWorkspace(workspaceId: string): Promise<GitWorkspace | null>;
}

export type GitSummary = {
  available: boolean;
  branch: string | null;
  branches?: string[];
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: { staged: number; unstaged: number; untracked: number };
  commits: Array<{
    hash: string;
    shortHash: string;
    subject: string;
    author: string;
    authoredAt: string;
  }>;
  fetchedAt: string | null;
};
