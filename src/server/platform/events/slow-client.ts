/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const slowClientLimitBytes = 1024 * 1024;
export function isSlowClient(bufferedBytes: number): boolean {
  return bufferedBytes > slowClientLimitBytes;
}
