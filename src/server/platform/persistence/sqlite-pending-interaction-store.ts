/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { DatabaseSync } from 'node:sqlite';

import type { PendingInteraction } from '../../features/sessions/model/relay-session.js';
import type { SafeInteractionSnapshot } from '../../../shared/contracts/chat-snapshot.js';

export class SqlitePendingInteractionStore {
  constructor(private readonly db: DatabaseSync) {}
  add(sessionId: string, interaction: PendingInteraction): void {
    this.db
      .prepare(
        'INSERT INTO pending_interactions (session_id,request_id,kind,payload_json,turn_id,requested_at) VALUES (?,?,?,?,?,?)',
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
    outcome: 'approved' | 'denied' | 'answered' = 'answered',
  ): boolean {
    return (
      this.db
        .prepare(
          'UPDATE pending_interactions SET resolved_at = ?, outcome = ? WHERE session_id = ? AND request_id = ? AND resolved_at IS NULL',
        )
        .run(resolvedAt, outcome, sessionId, requestId).changes === 1
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
  ): { resolvedAt: string; outcome: 'approved' | 'denied' | 'answered' } | null {
    const row = this.db
      .prepare(
        'SELECT resolved_at,outcome FROM pending_interactions WHERE session_id = ? AND request_id = ? AND resolved_at IS NOT NULL',
      )
      .get(sessionId, requestId) as { resolved_at: string; outcome: string | null } | undefined;
    return row
      ? {
          resolvedAt: row.resolved_at,
          outcome: (row.outcome as 'approved' | 'denied' | 'answered') ?? 'answered',
        }
      : null;
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
            outcome: (row.outcome as 'approved' | 'denied' | 'answered') ?? 'answered',
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
