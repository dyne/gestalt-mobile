/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type PushState = { enabled: boolean; reason: string | null };
export function pushState(input: { upstream: string | null; ahead: number }): PushState {
  if (!input.upstream) return { enabled: false, reason: 'No upstream branch is configured.' };
  if (input.ahead < 1) return { enabled: false, reason: 'There are no commits to push.' };
  return { enabled: true, reason: null };
}
