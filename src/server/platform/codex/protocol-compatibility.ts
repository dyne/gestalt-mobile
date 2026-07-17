/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function protocolCompatibility(
  installedVersion: string | null,
  protocolVersion: string | null,
): { compatible: boolean; code?: 'CODEX_NOT_FOUND' | 'CODEX_PROTOCOL_MISMATCH' } {
  if (!installedVersion) return { compatible: false, code: 'CODEX_NOT_FOUND' };
  if (installedVersion !== protocolVersion)
    return { compatible: false, code: 'CODEX_PROTOCOL_MISMATCH' };
  return { compatible: true };
}
