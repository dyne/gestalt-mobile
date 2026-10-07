/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type PushState = { enabled: boolean; reason: string | null };
export function pushState(input: {
  upstream: string | null;
  ahead: number;
  behind?: number;
  branch?: string | null;
  originUrl?: string | null;
}): PushState {
  if (input.branch === null) return { enabled: false, reason: 'Select a local branch to push.' };
  if (!input.upstream) {
    if (!input.branch) return { enabled: false, reason: 'Select a local branch to push.' };
    if (!input.originUrl) return { enabled: false, reason: 'No origin remote is configured.' };
    return { enabled: true, reason: null };
  }
  if ((input.behind ?? 0) > 0)
    return { enabled: false, reason: 'Pull upstream changes before pushing.' };
  if (input.ahead < 1) return { enabled: false, reason: 'There are no commits to push.' };
  return { enabled: true, reason: null };
}
