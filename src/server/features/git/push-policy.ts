/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function mayPush(input: {
  upstream: string | null;
  ahead: number;
  behind: number;
  branch?: string | null;
  originUrl?: string | null;
}): {
  allowed: boolean;
  reason?: string;
} {
  if (input.branch === null) return { allowed: false, reason: 'NO_BRANCH' };
  if (!input.upstream) {
    if (!input.branch) return { allowed: false, reason: 'NO_BRANCH' };
    if (!input.originUrl) return { allowed: false, reason: 'NO_ORIGIN' };
    return { allowed: true };
  }
  if (input.ahead < 1) return { allowed: false, reason: 'NOT_AHEAD' };
  if (input.behind > 0) return { allowed: false, reason: 'BEHIND_UPSTREAM' };
  return { allowed: true };
}
