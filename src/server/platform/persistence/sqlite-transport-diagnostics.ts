/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TransportDiagnostic } from '../../../shared/contracts/chat-transport-diagnostics.js';
import { closedSessionIds } from './retention.js';

export const transportLimit = 2048;
export const transportRetentionMs = 48 * 60 * 60 * 1000;

/** Separate from the replay journal: recording transport must never generate transport traffic. */
export class SqliteTransportDiagnostics {
  constructor(private readonly database: DatabaseSync) {}
  record(sessionId: string, value: TransportDiagnostic, now = Date.now()): void {
    // Diagnostics are best effort; storage failures cannot fail a history read or socket.
    try {
      const fields = safeMetadata(value);
      if (!fields) return;
      this.database
        .prepare(
          'INSERT INTO chat_transport_diagnostics(session_id, occurred_at, metadata_json) VALUES (?, ?, ?)',
        )
        .run(sessionId, now, JSON.stringify(fields));
      this.database
        .prepare(
          `DELETE FROM chat_transport_diagnostics WHERE session_id IN (${closedSessionIds}) AND (occurred_at < ? OR id <= COALESCE((SELECT id FROM chat_transport_diagnostics WHERE session_id IN (${closedSessionIds}) ORDER BY id DESC LIMIT 1 OFFSET ?), 0))`,
        )
        .run(now - transportRetentionMs, transportLimit);
    } catch {
      /* Optional telemetry must not change delivery semantics. */
    }
  }
}

export function readTransportDiagnostics(
  database: DatabaseSync,
  sessionId: string,
  now = Date.now(),
) {
  const available = Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_transport_diagnostics'",
      )
      .get(),
  );
  const rows = available
    ? database
        .prepare(
          `SELECT id, occurred_at AS occurredAt, metadata_json FROM chat_transport_diagnostics WHERE session_id = ? AND (session_id NOT IN (${closedSessionIds}) OR occurred_at >= ?) ORDER BY id DESC LIMIT ?`,
        )
        .all(sessionId, now - transportRetentionMs, transportLimit)
        .reverse()
    : [];
  return {
    available,
    coverage: 'retained-only' as const,
    closedSessionRecordLimit: transportLimit,
    exportRecordLimit: transportLimit,
    retentionMs: transportRetentionMs,
    records: rows.flatMap((row) => {
      try {
        const metadata = safeMetadata(JSON.parse(String(row.metadata_json)));
        return metadata
          ? [{ id: Number(row.id), occurredAt: Number(row.occurredAt), ...metadata }]
          : [];
      } catch {
        return [];
      }
    }),
  };
}

function safeMetadata(
  value: unknown,
): (Partial<TransportDiagnostic> & Pick<TransportDiagnostic, 'kind'>) | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (input.kind !== 'history' && input.kind !== 'replay' && input.kind !== 'resync') return null;
  const fields: Partial<TransportDiagnostic> & Pick<TransportDiagnostic, 'kind'> = {
    kind: input.kind,
  };
  for (const key of ['durationMs', 'status', 'after', 'count', 'attempts', 'coalesced'] as const) {
    const number = input[key];
    if (
      typeof number === 'number' &&
      Number.isFinite(number) &&
      number >= 0 &&
      number <= Number.MAX_SAFE_INTEGER
    )
      fields[key] = number;
  }
  return fields;
}
