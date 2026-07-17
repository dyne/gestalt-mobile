/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type GitSummary = {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  canPush: boolean;
};
export function toGitSummary(input: {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}): GitSummary {
  return { ...input, canPush: Boolean(input.upstream) && input.ahead > 0 };
}
