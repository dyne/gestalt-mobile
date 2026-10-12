/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Executable contract reference only. Production must add IO reconciliation,
// canonical permission scopes, process identities and current owner auth.
import { DatabaseSync } from 'node:sqlite';
import lifecycle from './live-lifecycle.json';

export type Run = {
  liveId: string;
  relayId: string;
  app: string;
  state: string;
  generation: number;
  revision: number;
};

export class OwnershipContract {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS fence (id INTEGER PRIMARY KEY CHECK(id = 1), value INTEGER NOT NULL);
      INSERT OR IGNORE INTO fence VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS runs (
        liveId TEXT PRIMARY KEY, relayId TEXT NOT NULL, app TEXT NOT NULL,
        state TEXT NOT NULL, generation INTEGER NOT NULL, revision INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS relay_claim ON runs(relayId) WHERE state <> 'idle';
      CREATE UNIQUE INDEX IF NOT EXISTS app_claim ON runs(app) WHERE state <> 'idle';
      CREATE TABLE IF NOT EXISTS dispatch (relayId TEXT PRIMARY KEY, app TEXT NOT NULL);
    `);
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private nextGeneration(): number {
    this.db.exec('UPDATE fence SET value = value + 1 WHERE id = 1');
    return Number(this.db.prepare('SELECT value FROM fence WHERE id = 1').get()!.value);
  }

  find(liveId: string): Run | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE liveId = ?').get(liveId) as Run | undefined;
  }

  start(liveId: string, relayId: string, app: string): Run {
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM dispatch WHERE relayId = ? OR app = ?').get(relayId, app))
        throw new Error('LIVE_SESSION_BUSY');
      if (this.db.prepare("SELECT 1 FROM runs WHERE relayId = ? AND state <> 'idle'").get(relayId))
        throw new Error('LIVE_MODE_ACTIVE');
      if (this.db.prepare("SELECT 1 FROM runs WHERE app = ? AND state <> 'idle'").get(app))
        throw new Error('LIVE_APP_BUSY');
      this.db
        .prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)')
        .run(liveId, relayId, app, 'starting', this.nextGeneration(), 1);
      return this.find(liveId)!;
    });
  }

  reserveDispatch(relayId: string, app: string): void {
    this.transaction(() => {
      if (
        this.db
          .prepare("SELECT 1 FROM runs WHERE (relayId = ? OR app = ?) AND state <> 'idle'")
          .get(relayId, app)
      )
        throw new Error('LIVE_MODE_ACTIVE');
      this.db.prepare('INSERT INTO dispatch VALUES (?, ?)').run(relayId, app);
    });
  }

  releaseQuiescentDispatch(relayId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM dispatch WHERE relayId = ?').run(relayId);
    });
  }

  transition(expected: Run, event: string): Run {
    return this.transaction(() => {
      const current = this.find(expected.liveId);
      if (
        !current ||
        current.generation !== expected.generation ||
        current.revision !== expected.revision
      )
        throw new Error('LIVE_GENERATION_STALE');
      const transition = lifecycle.transitions.find(
        (entry) => entry.from === current.state && entry.event === event,
      );
      if (!transition || event === 'start') throw new Error('LIVE_STATE_CONFLICT');
      const generation =
        event === 'restart' || event === 'reconciledResume'
          ? this.nextGeneration()
          : current.generation;
      this.db
        .prepare(
          'UPDATE runs SET state = ?, generation = ?, revision = revision + 1 WHERE liveId = ?',
        )
        .run(transition.to, generation, current.liveId);
      return this.find(current.liveId)!;
    });
  }

  close(): void {
    this.db.close();
  }
}

export type ControlIntent = {
  enabled: boolean;
  manualRevision: number;
  planIdentity: string;
  safe: boolean;
};

/** Offers an explicit post-Stop resume; it never enables Autopilot itself. */
export function resumeAvailable(prior: ControlIntent, current: ControlIntent): boolean {
  return (
    prior.enabled &&
    current.enabled &&
    prior.manualRevision === current.manualRevision &&
    prior.planIdentity === current.planIdentity &&
    current.safe
  );
}
