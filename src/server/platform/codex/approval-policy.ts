/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';
export function requiresApproval(policy: ApprovalPolicy, requested: boolean): boolean {
  return policy !== 'never' && requested;
}
