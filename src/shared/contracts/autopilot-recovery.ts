/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Safe, shared UI copy for the bounded checkpoint transport recovery path. */
export const checkpointHandoffRecoveryMessage =
  'Checkpoint handoff failed. Autopilot is reconnecting this session automatically. If it cannot recover, restore or reopen the session.';

/** Reconciliation can fail while the coordinator remains enabled for recovery. */
export const reconciliationRecoveryMessage =
  'Autopilot is recovering after a continuation or agent status check failed. It will retry automatically. If recovery persists, retry Autopilot or restore the session.';

export function isReconciliationRecovery(
  snapshot:
    | { state: string; enabled: boolean; reason?: string; health?: { healthy: boolean } }
    | null
    | undefined,
): boolean {
  return Boolean(
    snapshot?.enabled &&
    snapshot.state === 'monitoring' &&
    snapshot.reason === 'reconcileFailed' &&
    snapshot.health?.healthy !== true,
  );
}
