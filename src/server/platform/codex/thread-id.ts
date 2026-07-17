/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function requireThreadId(threadId: string | null): string {
  if (!threadId) throw new Error('THREAD_REQUIRED');
  return threadId;
}
