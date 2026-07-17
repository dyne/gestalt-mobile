/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const recoveryDelays = [500, 2000, 5000] as const;
export function recoveryDelay(failureCount: number): number | null {
  return recoveryDelays[failureCount] ?? null;
}
