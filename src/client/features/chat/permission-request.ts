/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function toPermissionApprovalResponse(payload: unknown): {
  permissions: Record<string, unknown>;
  scope: 'turn';
} | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const requested = (payload as { permissions?: unknown }).permissions;
  if (typeof requested !== 'object' || requested === null) return null;
  const profile = requested as { network?: unknown; fileSystem?: unknown };
  return {
    permissions: {
      ...(profile.network === null || profile.network === undefined
        ? {}
        : { network: profile.network }),
      ...(profile.fileSystem === null || profile.fileSystem === undefined
        ? {}
        : { fileSystem: profile.fileSystem }),
    },
    scope: 'turn',
  };
}
