/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  LaunchGrant,
  PreviewGrantStore,
  PreviewLease,
  LiveAudience,
  PreviewRevocationScope,
} from '../../features/live-design/application/ports.js';
import { withImmediateTransaction } from '../auth/sqlite.js';

/** Controller-private store adjacent to passkey state, never below a workspace/app root. */
export class SqlitePreviewGrantStore implements PreviewGrantStore {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(homeDirectory: string) {
    this.path = join(
      resolve(homeDirectory),
      '.codex-gestalt',
      'gestalt-mobile',
      'live-auth.sqlite',
    );
    const parent = dirname(this.path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (lstatSync(parent).isSymbolicLink())
      throw new Error('Private Live state must not be a symlink');
    chmodSync(parent, 0o700);
    try {
      if (!lstatSync(this.path).isFile()) throw new Error('Invalid private Live database');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.db = new DatabaseSync(this.path);
    try {
      chmodSync(this.path, 0o600);
      this.db.exec(`PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS live_grants (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS live_leases (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS live_revocations (kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind, value));
        CREATE TABLE IF NOT EXISTS live_attempts (key TEXT PRIMARY KEY, started INTEGER NOT NULL, count INTEGER NOT NULL);`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  saveGrant(grant: LaunchGrant): boolean {
    return withImmediateTransaction(this.db, () => {
      if (this.isRevoked(grant)) return false;
      this.db
        .prepare('INSERT INTO live_grants VALUES (?, ?, ?)')
        .run(grant.grantId, grant.tokenHash, JSON.stringify(grant));
      return true;
    });
  }
  exchange(
    grantId: string,
    validate: (grant: LaunchGrant) => PreviewLease | null,
  ): PreviewLease | null {
    return withImmediateTransaction(this.db, () => {
      const row = this.db.prepare('SELECT record FROM live_grants WHERE id = ?').get(grantId) as
        { record: string } | undefined;
      if (!row) return null;
      const grant = JSON.parse(row.record) as LaunchGrant;
      if (this.isRevoked(grant)) return null;
      const lease = validate(grant);
      if (!lease) return null;
      this.db.prepare('DELETE FROM live_grants WHERE id = ?').run(grantId);
      this.db
        .prepare('INSERT INTO live_leases VALUES (?, ?, ?)')
        .run(lease.leaseId, lease.tokenHash, JSON.stringify(lease));
      return lease;
    });
  }
  readLease(leaseId: string): PreviewLease | null {
    const row = this.db.prepare('SELECT record FROM live_leases WHERE id = ?').get(leaseId) as
      { record: string } | undefined;
    return row ? (JSON.parse(row.record) as PreviewLease) : null;
  }
  findLease(tokenHash: string): PreviewLease | null {
    const row = this.db
      .prepare('SELECT record FROM live_leases WHERE token_hash = ?')
      .get(tokenHash) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as PreviewLease) : null;
  }
  listLeases(authSessionHash: string, relayId: string): readonly PreviewLease[] {
    return (
      this.db
        .prepare(
          "SELECT record FROM live_leases WHERE json_extract(record, '$.authSessionHash') = ? AND json_extract(record, '$.relayId') = ?",
        )
        .all(authSessionHash, relayId) as { record: string }[]
    ).map((row) => JSON.parse(row.record) as PreviewLease);
  }
  renew(
    leaseId: string,
    update: (lease: PreviewLease) => PreviewLease | null,
  ): PreviewLease | null {
    return withImmediateTransaction(this.db, () => {
      const lease = this.readLease(leaseId);
      const next = lease ? update(lease) : null;
      if (next)
        this.db
          .prepare('UPDATE live_leases SET record = ? WHERE id = ?')
          .run(JSON.stringify(next), leaseId);
      return next;
    });
  }
  attempt(key: string, now: number): boolean {
    const attempt = () => {
      this.db.prepare('DELETE FROM live_attempts WHERE started <= ?').run(now - 60_000);
      this.db
        .prepare("DELETE FROM live_grants WHERE json_extract(record, '$.expiresAt') <= ?")
        .run(new Date(now).toISOString());
      const row = this.db.prepare('SELECT count FROM live_attempts WHERE key = ?').get(key) as
        { count: number } | undefined;
      if (row) {
        if (row.count >= 10) return false;
        this.db.prepare('UPDATE live_attempts SET count = count + 1 WHERE key = ?').run(key);
      } else {
        const size = this.db.prepare('SELECT COUNT(*) AS total FROM live_attempts').get() as {
          total: number;
        };
        if (size.total >= 4096) return false;
        this.db.prepare('INSERT INTO live_attempts VALUES (?, ?, 1)').run(key, now);
      }
      return true;
    };
    return this.db.isTransaction ? attempt() : withImmediateTransaction(this.db, attempt);
  }
  revoke(match: PreviewRevocationScope): void {
    const fields = Object.entries(match);
    if (
      fields.length !== 1 ||
      !['authSessionHash', 'deviceId', 'liveId'].includes(fields[0]![0]) ||
      !fields[0]![1]
    )
      throw new Error('Revocation requires one valid scope');
    const [field, value] = fields[0]!;
    withImmediateTransaction(this.db, () => {
      this.db.prepare('INSERT OR IGNORE INTO live_revocations VALUES (?, ?)').run(field, value);
      for (const table of ['live_grants', 'live_leases'])
        this.db
          .prepare(`DELETE FROM ${table} WHERE json_extract(record, '$.${field}') = ?`)
          .run(value);
    });
  }
  private isRevoked(audience: LiveAudience): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM live_revocations WHERE
      (kind = 'authSessionHash' AND value = ?) OR (kind = 'deviceId' AND value = ?) OR
      (kind = 'liveId' AND value = ?) LIMIT 1`,
        )
        .get(audience.authSessionHash, audience.deviceId, audience.liveId) !== undefined
    );
  }
  close(): void {
    this.db.close();
  }
}
