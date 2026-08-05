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
  const installed = parseCoreVersion(installedVersion);
  const expected = protocolVersion ? parseCoreVersion(protocolVersion) : undefined;
  // 0.x is pre-1.0: the minor is the core wire contract.  Patch releases and
  // newer compatible minors are accepted only within a small forward window;
  // optional APIs are negotiated independently at runtime.
  if (!installed || !expected || !coreCompatible(installed, expected))
    return { compatible: false, code: 'CODEX_PROTOCOL_MISMATCH' };
  return { compatible: true };
}

function parseCoreVersion(value: string): { major: number; minor: number } | undefined {
  const match = /\b(\d+)\.(\d+)(?:\.(\d+))?\b/.exec(value);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function coreCompatible(installed: { major: number; minor: number }, expected: { major: number; minor: number }): boolean {
  if (installed.major !== expected.major) return false;
  if (installed.major !== 0) return installed.minor === expected.minor;
  return installed.minor >= expected.minor && installed.minor <= expected.minor + 4;
}
