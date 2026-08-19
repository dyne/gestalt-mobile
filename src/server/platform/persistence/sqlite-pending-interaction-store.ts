/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { DatabaseSync } from 'node:sqlite';

import type { PendingInteraction } from '../../features/sessions/model/relay-session.js';
import type { SafeInteractionSnapshot } from '../../../shared/contracts/chat-snapshot.js';

type SafeInteractionOutcome = Extract<SafeInteractionSnapshot, { resolvedAt: string }>['outcome'];

function safeInteractionOutcome(value: unknown): SafeInteractionOutcome {
  return value === 'approved' ||
    value === 'denied' ||
    value === 'answered' ||
    value === 'dismissed' ||
    value === 'failed'
    ? value
    : 'answered';
}

export class SqlitePendingInteractionStore {
  constructor(private readonly db: DatabaseSync) {}
  add(sessionId: string, interaction: PendingInteraction): void {
    this.db
      .prepare(
        `INSERT INTO pending_interactions (session_id,request_id,kind,payload_json,turn_id,requested_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(session_id,request_id) DO UPDATE SET
           kind = excluded.kind, payload_json = excluded.payload_json, turn_id = excluded.turn_id,
           requested_at = excluded.requested_at, resolved_at = NULL, outcome = NULL, operation_key = NULL,
           resolution_state = 'active'
         WHERE pending_interactions.kind != 'orgPlanAttention'`,
      )
      .run(
        sessionId,
        interaction.requestId,
        interaction.kind,
        JSON.stringify(interaction.payload),
        interaction.turnId ?? null,
        interaction.requestedAt ?? null,
      );
  }
  resolve(
    sessionId: string,
    requestId: string,
    resolvedAt: string,
    outcome: SafeInteractionOutcome = 'answered',
  ): boolean {
    return (
      this.db
        .prepare(
          'UPDATE pending_interactions SET resolved_at = ?, outcome = ? WHERE session_id = ? AND request_id = ? AND resolved_at IS NULL',
        )
        .run(resolvedAt, outcome, sessionId, requestId).changes === 1
    );
  }
  /**
   * The operation key is claimed before a writer is touched.  A matching retry
   * keeps that claim, whereas another key is permanently stale.
   */
  claimOperation(
    sessionId: string,
    requestId: string,
    operationKey: string,
  ): 'claimed' | 'same' | 'stale' | 'resolved' | 'missing' {
    const row = this.db
      .prepare(
        'SELECT resolved_at,operation_key FROM pending_interactions WHERE session_id = ? AND request_id = ?',
      )
      .get(sessionId, requestId) as
      { resolved_at: string | null; operation_key: string | null } | undefined;
    if (!row) return 'missing';
    if (row.resolved_at) return row.operation_key === operationKey ? 'resolved' : 'stale';
    if (row.operation_key) return row.operation_key === operationKey ? 'same' : 'stale';
    return this.db
      .prepare(
        'UPDATE pending_interactions SET operation_key = ? WHERE session_id = ? AND request_id = ? AND operation_key IS NULL AND resolved_at IS NULL',
      )
      .run(operationKey, sessionId, requestId).changes === 1
      ? 'claimed'
      : 'stale';
  }
  /** Persist the in-flight delivery boundary before the app-server is notified. */
  beginDelivery(sessionId: string, requestId: string, operationKey: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE pending_interactions SET resolution_state = 'delivering' WHERE session_id = ? AND request_id = ? AND operation_key = ? AND resolved_at IS NULL AND resolution_state IN ('active','delivering')",
        )
        .run(sessionId, requestId, operationKey).changes === 1
    );
  }
  /** A local writer outage is retryable only by the already-claimed key. */
  retryDelivery(sessionId: string, requestId: string, operationKey: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE pending_interactions SET resolution_state = 'active' WHERE session_id = ? AND request_id = ? AND operation_key = ? AND resolved_at IS NULL AND resolution_state = 'delivering'",
        )
        .run(sessionId, requestId, operationKey).changes === 1
    );
  }
  /** Terminal state is durable before publishing a success/failure event. */
  settleOperation(
    sessionId: string,
    requestId: string,
    operationKey: string,
    resolvedAt: string,
    outcome: SafeInteractionOutcome,
  ): boolean {
    return (
      this.db
        .prepare(
          "UPDATE pending_interactions SET resolved_at = ?, outcome = ?, resolution_state = ? WHERE session_id = ? AND request_id = ? AND operation_key = ? AND resolved_at IS NULL AND resolution_state = 'delivering'",
        )
        .run(
          resolvedAt,
          outcome,
          outcome === 'failed' ? 'failed' : 'resolved',
          sessionId,
          requestId,
          operationKey,
        ).changes === 1
    );
  }
  list(sessionId: string): PendingInteraction[] {
    return (
      this.db
        .prepare(
          'SELECT request_id,kind,payload_json,turn_id,requested_at FROM pending_interactions WHERE session_id = ? AND resolved_at IS NULL ORDER BY rowid',
        )
        .all(sessionId) as Array<{
        request_id: string;
        kind: PendingInteraction['kind'];
        payload_json: string;
        turn_id: string | null;
        requested_at: string | null;
      }>
    ).map((row) => ({
      requestId: row.request_id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json),
      ...(row.turn_id ? { turnId: row.turn_id } : {}),
      ...(row.requested_at ? { requestedAt: row.requested_at } : {}),
    }));
  }
  find(sessionId: string, requestId: string): PendingInteraction | null {
    return this.list(sessionId).find((interaction) => interaction.requestId === requestId) ?? null;
  }
  resolved(
    sessionId: string,
    requestId: string,
  ): { resolvedAt: string; outcome: SafeInteractionOutcome } | null {
    const row = this.db
      .prepare(
        'SELECT resolved_at,outcome,operation_key FROM pending_interactions WHERE session_id = ? AND request_id = ? AND resolved_at IS NOT NULL',
      )
      .get(sessionId, requestId) as
      { resolved_at: string; outcome: string | null; operation_key: string | null } | undefined;
    return row
      ? {
          resolvedAt: row.resolved_at,
          outcome: safeInteractionOutcome(row.outcome),
        }
      : null;
  }
  terminalOperation(
    sessionId: string,
    requestId: string,
  ): { resolvedAt: string; outcome: SafeInteractionOutcome; operationKey: string | null } | null {
    const resolved = this.resolved(sessionId, requestId);
    if (!resolved) return null;
    const row = this.db
      .prepare(
        'SELECT operation_key FROM pending_interactions WHERE session_id = ? AND request_id = ?',
      )
      .get(sessionId, requestId) as { operation_key: string | null } | undefined;
    return row ? { ...resolved, operationKey: row.operation_key } : null;
  }
  snapshot(sessionId: string): SafeInteractionSnapshot[] {
    return (
      this.db
        .prepare(
          'SELECT request_id,kind,payload_json,turn_id,requested_at,resolved_at,outcome FROM pending_interactions WHERE session_id = ? ORDER BY CASE WHEN resolved_at IS NULL THEN 0 ELSE 1 END, requested_at, rowid',
        )
        .all(sessionId) as Array<{
        request_id: string;
        kind: PendingInteraction['kind'];
        payload_json: string;
        turn_id: string | null;
        requested_at: string | null;
        resolved_at: string | null;
        outcome: string | null;
      }>
    ).map((row) =>
      row.resolved_at
        ? {
            requestId: row.request_id,
            kind: row.kind,
            turnId: row.turn_id,
            requestedAt: row.requested_at,
            resolvedAt: row.resolved_at,
            outcome: safeInteractionOutcome(row.outcome),
          }
        : {
            requestId: row.request_id,
            kind: row.kind,
            turnId: row.turn_id,
            requestedAt: row.requested_at,
            resolvedAt: null,
            payload: JSON.parse(row.payload_json),
          },
    );
  }
}
