/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { RelaySession } from '../model/relay-session.js';
import type { RelaySessionSnapshot } from '../model/relay-session.js';
export function canRestore(session: RelaySessionSnapshot): boolean {
  return (
    session.threadId !== null &&
    (session.state === 'stopped' ||
      session.state === 'released' ||
      session.state === 'attentionRequired')
  );
}
export function restore(session: RelaySessionSnapshot, now: string): RelaySessionSnapshot {
  if (!canRestore(session)) throw new Error('SESSION_CANNOT_RESTORE');
  return RelaySession.rehydrate(session).beginRecovery(now).restore(now).snapshot;
}
