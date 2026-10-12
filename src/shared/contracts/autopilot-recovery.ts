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
  'Autopilot cannot confirm agent status. Automatic continuation is waiting for session recovery. If this persists, restore or reopen the session, then retry Autopilot, or disable it to continue manually.';

export function isReconciliationRecovery(
  snapshot: { state: string; enabled: boolean; reason?: string } | null | undefined,
): boolean {
  return Boolean(
    snapshot?.enabled && snapshot.state === 'monitoring' && snapshot.reason === 'reconcileFailed',
  );
}
