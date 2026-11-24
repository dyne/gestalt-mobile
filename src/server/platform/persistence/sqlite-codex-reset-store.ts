/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CodexAutoResetStatus } from '../../../shared/contracts/codex-allowance.js';
import {
  resetCreditCooldownMs,
  type CodexResetStore,
} from '../../features/catalog/application/codex-auto-reset.js';

/** All workspaces share this account-level ledger, independent of relay.sqlite. */
export class SqliteCodexResetStore implements CodexResetStore {
  private readonly path: string;
  constructor(homeDirectory: string) {
    this.path = join(homeDirectory, '.gestalt', 'codex-reset-credits.sqlite');
  }

  private open(): DatabaseSync | undefined {
    if (!statSync(this.path, { throwIfNoEntry: false })) return undefined;
    const db = new DatabaseSync(this.path, { timeout: 1_000 });
    try {
      if (
        db
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'codex_reset_settings'",
          )
          .get()
      )
        return db;
    } catch (error) {
      db.close();
      throw error;
    }
    db.close();
    return undefined;
  }

  enabled(): boolean {
    using db = this.open();
    return (
      db?.prepare('SELECT enabled FROM codex_reset_settings WHERE id = 1').get()?.enabled === 1
    );
  }

  status(): CodexAutoResetStatus {
    using db = this.open();
    if (!db) return { enabled: false, resets: [] };
    return {
      enabled:
        db.prepare('SELECT enabled FROM codex_reset_settings WHERE id = 1').get()?.enabled === 1,
      resets: db
        .prepare(
          'SELECT id, reset_at AS occurredAt FROM codex_reset_attempts WHERE reset_at IS NOT NULL ORDER BY reset_at DESC LIMIT 50',
        )
        .all() as CodexAutoResetStatus['resets'],
    };
  }

  setEnabled(enabled: boolean): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    closeSync(openSync(this.path, 'a', 0o600));
    using db = new DatabaseSync(this.path, { timeout: 1_000 });
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS codex_reset_settings (id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS codex_reset_attempts (
        id TEXT PRIMARY KEY, attempted_at INTEGER NOT NULL, weekly_resets_at INTEGER NOT NULL, reset_at INTEGER
      );
      COMMIT;`);
    db.prepare(
      `INSERT INTO codex_reset_settings (id, enabled) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled`,
    ).run(Number(enabled));
  }

  claim(id: string, now: number, weeklyResetsAt: number): boolean {
    using db = this.open();
    // One atomic write across processes checks opt-in, cooldown and original
    // window. Keeping attempted windows fences stale reads and uncertain replies.
    return (
      db
        ?.prepare(
          `INSERT INTO codex_reset_attempts (id, attempted_at, weekly_resets_at)
      SELECT ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM codex_reset_settings WHERE id = 1 AND enabled = 1)
        AND NOT EXISTS (
          SELECT 1 FROM codex_reset_attempts
            WHERE attempted_at > ? OR reset_at > ? OR weekly_resets_at >= ?
        )`,
        )
        .run(
          id,
          now,
          weeklyResetsAt,
          now - resetCreditCooldownMs,
          now - resetCreditCooldownMs,
          weeklyResetsAt,
        ).changes === 1
    );
  }

  recordReset(id: string, occurredAt: number): void {
    using db = this.open();
    db?.prepare(
      'UPDATE codex_reset_attempts SET reset_at = ? WHERE id = ? AND reset_at IS NULL',
    ).run(occurredAt, id);
  }
}
