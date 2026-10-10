/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PreviewOriginAssignment } from '../../features/live-design/application/routes.js';
import { withImmediateTransaction } from '../auth/sqlite.js';

export type StoredCaddyRoute = PreviewOriginAssignment & {
  desired: string | null;
  applied: string | null;
  registrationId: string | null;
};
/** Private controller state. Never delete assignment rows, including after Stop. */
export class CaddyRouteStore {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    readonly hostname: string,
    readonly ports: readonly number[],
    options: { initialize?: boolean } = {},
  ) {
    if (
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/.test(hostname) ||
      ports.length < 1 ||
      ports.length > 32 ||
      new Set(ports).size !== ports.length ||
      ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)
    )
      throw new Error('LIVE_PREVIEW_POOL_INVALID');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error('LIVE_PRIVATE_STATE_INVALID');
    let existing = true;
    try {
      if (!lstatSync(path).isFile()) throw new Error('LIVE_PRIVATE_STATE_INVALID');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      existing = false;
    }
    if (!existing && !options.initialize) throw new Error('LIVE_ORIGIN_STATE_MISSING');
    this.db = new DatabaseSync(path);
    if (
      existing &&
      !this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_origins'")
        .get()
    ) {
      this.db.close();
      throw new Error('LIVE_ORIGIN_STATE_MISSING');
    }
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS live_origins (
        canonicalAppRoot TEXT PRIMARY KEY, origin TEXT UNIQUE NOT NULL,
        port INTEGER NOT NULL, serverId TEXT UNIQUE NOT NULL,
        desired TEXT, applied TEXT, registrationId TEXT
      );`);
    // Prevent changing pools/hostname from silently aliasing old service-worker origins.
    for (const row of this.list())
      if (row.origin !== `https://${hostname}:${row.port}` || !ports.includes(row.port)) {
        this.db.close();
        throw new Error('LIVE_PREVIEW_POOL_CHANGED');
      }
  }
  assign(appRoot: string): StoredCaddyRoute {
    const canonical = realpathSync(appRoot);
    return withImmediateTransaction(this.db, () => {
      const current = this.read(canonical);
      if (current) return current;
      const assigned = new Set(this.list().map((row) => row.port));
      const port = this.ports.find((port) => !assigned.has(port));
      if (port === undefined) throw new Error('LIVE_PREVIEW_POOL_EXHAUSTED');
      const origin = `https://${this.hostname}:${port}`;
      const serverId = `gestalt_live_${createHash('sha256').update(origin).digest('hex').slice(0, 32)}`;
      this.db
        .prepare('INSERT INTO live_origins VALUES (?, ?, ?, ?, NULL, NULL, NULL)')
        .run(canonical, origin, port, serverId);
      return this.read(canonical)!;
    });
  }
  read(appRoot: string): StoredCaddyRoute | null {
    return (
      (this.db.prepare('SELECT * FROM live_origins WHERE canonicalAppRoot=?').get(appRoot) as
        StoredCaddyRoute | undefined) ?? null
    );
  }
  list(): StoredCaddyRoute[] {
    return this.db.prepare('SELECT * FROM live_origins ORDER BY port').all() as StoredCaddyRoute[];
  }
  desire(appRoot: string, server: unknown | null, registrationId: string | null = null): void {
    this.db
      .prepare('UPDATE live_origins SET desired=?, registrationId=? WHERE canonicalAppRoot=?')
      .run(server === null ? null : JSON.stringify(server), registrationId, appRoot);
  }
  acknowledge(appRoot: string, server: string | null): void {
    this.db
      .prepare('UPDATE live_origins SET applied=? WHERE canonicalAppRoot=?')
      .run(server, appRoot);
  }
  close(): void {
    this.db.close();
  }
}
