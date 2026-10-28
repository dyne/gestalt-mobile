/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const eventRetentionMs = 48 * 60 * 60 * 1000;

/** Idle turns, recovery and attention do not close a durable session. */
export const closedSessionIds = `SELECT id FROM relay_sessions
  WHERE state IN ('stopped', 'released') AND desired_state = 'stopped'
    AND active_turn_id IS NULL`;

export function eventRetentionCutoff(occurredAt: string): string | null {
  const timestamp = Date.parse(occurredAt);
  return Number.isFinite(timestamp) ? new Date(timestamp - eventRetentionMs).toISOString() : null;
}
