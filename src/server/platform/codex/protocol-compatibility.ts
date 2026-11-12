/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { protocolErrorCode } from './error-code.js';

/** Retain the public health flag without using version text as admission policy.
 * Runtime operations and capability checks establish actual protocol support.
 */
export function protocolCompatibility(installedVersion: string | null): {
  compatible: boolean;
  code?: 'CODEX_NOT_FOUND';
} {
  const code = protocolErrorCode(installedVersion);
  return code ? { compatible: false, code } : { compatible: true };
}
