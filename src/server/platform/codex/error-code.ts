/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function protocolErrorCode(
  installed: string | null,
  expected: string | null,
): 'CODEX_NOT_FOUND' | 'CODEX_PROTOCOL_MISMATCH' | null {
  if (!installed) return 'CODEX_NOT_FOUND';
  return installed === expected ? null : 'CODEX_PROTOCOL_MISMATCH';
}
