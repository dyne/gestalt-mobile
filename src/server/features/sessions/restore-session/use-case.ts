/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { RelaySession } from '../model/relay-session.js';
import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { threadId } from '../model/value-objects.js';
import { isMissingCodexThreadRollout } from '../../../platform/codex/json-rpc-client.js';
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

export type MissingRolloutRecovery = {
  session: RelaySessionSnapshot;
  historyUnavailable: true;
  replacementCreated: true;
};

/**
 * The runtime may replace a thread only after a failed resume is confirmed to
 * be the historical-rollout case.  This pure policy leaves persistence to the
 * caller, so the original thread remains durable until thread/start succeeds.
 */
export function canRebindMissingRollout(session: RelaySessionSnapshot, error: unknown): boolean {
  return canRestore(session) && isMissingCodexThreadRollout(error);
}

export function rebindMissingRollout(
  session: RelaySessionSnapshot,
  error: unknown,
  replacementThreadId: string,
  now: string,
): MissingRolloutRecovery {
  if (!canRebindMissingRollout(session, error)) throw new Error('CODEX_ROLLOUT_REBIND_NOT_ALLOWED');
  threadId(replacementThreadId);
  return {
    session: RelaySession.rehydrate(session).bindThread(replacementThreadId, now).snapshot,
    historyUnavailable: true,
    replacementCreated: true,
  };
}
