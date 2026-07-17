/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RelaySessionSnapshot } from '../model/relay-session.js';
export function interruptTurn(
  session: RelaySessionSnapshot,
  turnId: string,
): { accepted: boolean; code?: string } {
  return session.activeTurnId === turnId
    ? { accepted: true }
    : { accepted: false, code: 'TURN_NOT_ACTIVE' };
}
