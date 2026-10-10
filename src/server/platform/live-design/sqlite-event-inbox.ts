/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LiveRun } from '../../features/live-design/application/ownership.js';
import type {
  InboxEvent,
  InboxStage,
  LiveEventInbox,
  LivePollEvent,
} from '../../features/live-design/application/poll-events.js';
import { withImmediateTransaction } from '../auth/sqlite.js';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function eventDigest(event: LivePollEvent): string {
  // Controller/poller-generated enrichments may change across lease deliveries.
  const source = Object.fromEntries(
    Object.entries(event).filter(
      ([key]) =>
        !key.startsWith('_') &&
        ![
          'scaffold',
          'scaffoldAttempted',
          'scaffoldError',
          'screenshotPath',
          'generationReadyAt',
        ].includes(key),
    ),
  );
  return createHash('sha256').update(stable(source)).digest('hex');
}

/** Shared private SQLite file: an app has at most one durable poll intent across processes.
 * Expiry/death does not release an intent; only explicit journal/source reconciliation may.
 * Tombstones are retained: capacity exhaustion blocks rather than evicting deduplication proof.
 */
export class SqliteLiveEventInbox implements LiveEventInbox {
  private readonly db: DatabaseSync;
  private readonly directory: string;
  constructor(
    path: string,
    private readonly limit = 256,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 4096)
      throw new Error('LIVE_INBOX_LIMIT_INVALID');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error('LIVE_PRIVATE_STATE_INVALID');
    this.directory = realpathSync(dirname(path));
    chmodSync(this.directory, 0o700);
    try {
      if (!lstatSync(path).isFile()) throw new Error('LIVE_PRIVATE_STATE_INVALID');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS live_poll_intents (
        app TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, liveId TEXT NOT NULL,
        generation INTEGER NOT NULL, epoch INTEGER NOT NULL, phase TEXT NOT NULL, code TEXT);
      CREATE TABLE IF NOT EXISTS live_event_inbox (
        app TEXT NOT NULL, liveId TEXT NOT NULL, generation INTEGER NOT NULL,
        key TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(app,liveId,generation,key));`);
  }
  private intent(token: string) {
    const row = this.db.prepare('SELECT * FROM live_poll_intents WHERE token=?').get(token);
    if (!row || row.phase !== 'polling') throw new Error('LIVE_POLL_RECOVERY_REQUIRED');
    return row;
  }
  begin(run: LiveRun): string {
    const tail = relative(run.app.canonicalAppRoot, this.directory);
    if (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`))
      throw new Error('LIVE_PRIVATE_STATE_INSIDE_APP');
    return withImmediateTransaction(this.db, () => {
      const app = `${run.app.device}:${run.app.inode}`;
      if (this.db.prepare('SELECT 1 FROM live_poll_intents WHERE app=?').get(app))
        throw new Error('LIVE_POLL_RECOVERY_REQUIRED');
      // Hard global bound; completed generations are not silently forgotten.
      const count = this.db.prepare('SELECT count(*) AS n FROM live_event_inbox').get()!;
      if (Number(count.n) >= this.limit) throw new Error('LIVE_INBOX_FULL');
      const token = randomUUID();
      this.db
        .prepare('INSERT INTO live_poll_intents VALUES (?,?,?,?,?,?,NULL)')
        .run(app, token, run.liveId, run.generation, run.controllerEpoch, 'polling');
      return token;
    });
  }
  receive(token: string, event: LivePollEvent, now: number): InboxEvent {
    return withImmediateTransaction(this.db, () => {
      const intent = this.intent(token);
      const digest = eventDigest(event);
      // All edit events use the upstream ID + owning generation. Type/digest disambiguate
      // a session's generate, steer, mount repair and terminal events. No-ID events have
      // no side effects/reply and are removed on lease by the pinned upstream server.
      const key = `${event.id ?? 'notification'}:${event.type}:${digest}`;
      const old = this.db
        .prepare(
          'SELECT record FROM live_event_inbox WHERE app=? AND liveId=? AND generation=? AND key=?',
        )
        .get(intent.app!, intent.liveId!, intent.generation!, key);
      if (old) {
        const item = JSON.parse(String(old.record)) as InboxEvent;
        if (item.stage !== 'acknowledged') throw new Error('LIVE_POLL_RECOVERY_REQUIRED');
        return item;
      }
      const count = Number(this.db.prepare('SELECT count(*) AS n FROM live_event_inbox').get()!.n);
      if (count >= this.limit) throw new Error('LIVE_INBOX_FULL');
      const item: InboxEvent = {
        key,
        upstreamId: event.id ?? null,
        kind: event.type,
        digest,
        stage: 'received',
        leaseUntil: now + 595000,
        history: ['received'],
      };
      this.db
        .prepare('INSERT INTO live_event_inbox VALUES (?,?,?,?,?)')
        .run(intent.app!, intent.liveId!, intent.generation!, key, JSON.stringify(item));
      return item;
    });
  }
  advance(token: string, key: string, stage: InboxStage): void {
    withImmediateTransaction(this.db, () => {
      const intent = this.intent(token);
      const row = this.db
        .prepare(
          'SELECT record FROM live_event_inbox WHERE app=? AND liveId=? AND generation=? AND key=?',
        )
        .get(intent.app!, intent.liveId!, intent.generation!, key);
      if (!row) throw new Error('LIVE_INBOX_STATE_INVALID');
      const item = JSON.parse(String(row.record)) as InboxEvent;
      const order: InboxStage[] = ['received', 'dispatched', 'applied', 'acknowledged'];
      if (order.indexOf(stage) !== order.indexOf(item.stage) + 1)
        throw new Error('LIVE_INBOX_STATE_INVALID');
      item.stage = stage;
      item.history = [...item.history, stage];
      this.db
        .prepare(
          'UPDATE live_event_inbox SET record=? WHERE app=? AND liveId=? AND generation=? AND key=?',
        )
        .run(JSON.stringify(item), intent.app!, intent.liveId!, intent.generation!, key);
    });
  }
  knownTerminal(token: string, id: string, kind: string): boolean {
    // A terminal receipt closes the whole session, including an out-of-order
    // generate/steer restored after it. Notifications without IDs are unaffected.
    if (!kind) return false;
    const intent = this.intent(token);
    return this.db
      .prepare('SELECT record FROM live_event_inbox WHERE app=? AND liveId=? AND generation=?')
      .all(intent.app!, intent.liveId!, intent.generation!)
      .some((row) => {
        const event = JSON.parse(String(row.record)) as InboxEvent;
        return event.upstreamId === id && (event.kind === 'accept' || event.kind === 'discard');
      });
  }
  finish(token: string): void {
    withImmediateTransaction(this.db, () => {
      const intent = this.intent(token);
      const unfinished = this.db
        .prepare('SELECT record FROM live_event_inbox WHERE app=? AND liveId=? AND generation=?')
        .all(intent.app!, intent.liveId!, intent.generation!)
        .some((row) => (JSON.parse(String(row.record)) as InboxEvent).stage !== 'acknowledged');
      if (unfinished) throw new Error('LIVE_POLL_RECOVERY_REQUIRED');
      this.db.prepare('DELETE FROM live_poll_intents WHERE token=?').run(token);
    });
  }
  recover(token: string, code: string): void {
    this.db
      .prepare("UPDATE live_poll_intents SET phase='recoveryRequired',code=? WHERE token=?")
      .run(/^LIVE_[A-Z_]+$/.test(code) ? code : 'LIVE_POLL_RECOVERY_REQUIRED', token);
  }
  /** Read-only recovery evidence; never a retry/lease-takeover API. */
  records(): InboxEvent[] {
    return this.db
      .prepare('SELECT record FROM live_event_inbox')
      .all()
      .map((row) => JSON.parse(String(row.record)) as InboxEvent);
  }
  close(): void {
    this.db.close();
  }
}
