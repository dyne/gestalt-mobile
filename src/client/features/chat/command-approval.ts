/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function readCommandApproval(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const command = (payload as { command?: unknown }).command;
  return typeof command === 'string' && command.trim() ? command : null;
}
