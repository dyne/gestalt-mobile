/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { RelyingPartyConfig } from '../../config.js';
import type { AuthorizationRepository } from '../../features/auth/application/ports.js';
import type {
  AuthorizationSession,
  AuthorizedDevice,
  EnrollmentTicket,
  LocalOwner,
  PasskeyCeremony,
} from '../../features/auth/domain/authorization.js';
import {
  authorizedDeviceId,
  localOwnerId,
  passkeyCeremonyId,
  webAuthnCredentialId,
} from '../../features/auth/domain/identifiers.js';
import { deviceNickname } from '../../features/auth/domain/device-nickname.js';
import { CeremonyCapacityError } from '../../features/auth/domain/errors.js';
import { AuthStatementCache, withImmediateTransaction } from './sqlite.js';

const OWNER_ID = localOwnerId('local-owner');
const SCHEMA_VERSION = 1;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_STARTUP_BUSY_TIMEOUT_MS = 250;
const STARTUP_LOCK_DEADLINE_MS = 2_000;
const STARTUP_LOCK_RETRY_DELAY_MS = 25;
const startupLockWaiter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export function authorizationDatabasePath(homeDirectory: string): string {
  return join(resolve(homeDirectory), '.codex-gestalt', 'gestalt-mobile', 'auth.sqlite');
}

/** SQLite adapter for the auth bounded context. No SQLite types escape this file. */
export class SqliteAuthorizationStore implements AuthorizationRepository {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly statements: AuthStatementCache;
  private readonly relyingParty: RelyingPartyConfig;

  constructor(homeDirectory: string, relyingParty: RelyingPartyConfig) {
    this.path = authorizationDatabasePath(homeDirectory);
    const parent = dirname(this.path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
    this.relyingParty = relyingParty;
    this.db = new DatabaseSync(this.path);
    this.statements = new AuthStatementCache(this.db);
    try {
      // journal_mode can take an exclusive lock. Install the bounded busy handler first so
      // simultaneous first opens wait for the winner instead of failing during startup.
      this.db.exec(`PRAGMA busy_timeout = ${SQLITE_STARTUP_BUSY_TIMEOUT_MS}`);
      this.initializeSchema();
      this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private initializeSchema(): void {
    const deadline = Date.now() + STARTUP_LOCK_DEADLINE_MS;
    for (;;) {
      try {
        this.initializeSchemaAttempt();
        return;
      } catch (error) {
        const remaining = deadline - Date.now();
        if (!isLocked(error) || remaining <= 0) throw error;
        Atomics.wait(startupLockWaiter, 0, 0, Math.min(STARTUP_LOCK_RETRY_DELAY_MS, remaining));
      }
    }
  }

  private initializeSchemaAttempt(): void {
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    withImmediateTransaction(this.db, () => {
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS auth_settings (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL, rp_id TEXT NOT NULL, user_handle BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS auth_devices (id TEXT PRIMARY KEY, credential_id TEXT NOT NULL UNIQUE, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports_json TEXT NOT NULL, device_type TEXT NOT NULL, backed_up INTEGER NOT NULL CHECK(backed_up IN (0,1)), nickname TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS auth_ceremonies (token_hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, challenge BLOB NOT NULL, expected_origin TEXT NOT NULL, rp_id TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, ticket_hash TEXT);
CREATE TABLE IF NOT EXISTS auth_tickets (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, consumed_at TEXT, creator_session_hash TEXT);
CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, device_id TEXT REFERENCES auth_devices(id) ON DELETE SET NULL, expires_at TEXT NOT NULL, revoked_at TEXT);`);
      const ceremonyColumns = this.db
        .prepare("SELECT name FROM pragma_table_info('auth_ceremonies')")
        .all() as { name: string }[];
      if (!ceremonyColumns.some((column) => column.name === 'ticket_hash'))
        this.db.exec('ALTER TABLE auth_ceremonies ADD COLUMN ticket_hash TEXT');
      const ticketColumns = this.db
        .prepare("SELECT name FROM pragma_table_info('auth_tickets')")
        .all() as { name: string }[];
      if (!ticketColumns.some((column) => column.name === 'creator_session_hash'))
        this.db.exec('ALTER TABLE auth_tickets ADD COLUMN creator_session_hash TEXT');
      const settings = this.db
        .prepare('SELECT rp_id FROM auth_settings WHERE singleton = 1')
        .get() as { rp_id: string } | undefined;
      if (settings && settings.rp_id !== this.relyingParty.rpId && this.deviceCount() > 0)
        throw new Error('WebAuthn RP ID hostname changed while credentials exist');
    });
  }

  initializeOwner(userHandle: Uint8Array): LocalOwner {
    if (userHandle.length === 0) throw new Error('Local owner handle must not be empty');
    return withImmediateTransaction(this.db, () => {
      const current = this.statements
        .prepare('SELECT user_handle, rp_id FROM auth_settings WHERE singleton = 1')
        .get() as { user_handle: Uint8Array; rp_id: string } | undefined;
      if (!current)
        this.statements
          .prepare(
            'INSERT INTO auth_settings (singleton, schema_version, rp_id, user_handle) VALUES (1, ?, ?, ?)',
          )
          .run(SCHEMA_VERSION, this.relyingParty.rpId, userHandle);
      else if (current.rp_id !== this.relyingParty.rpId && this.deviceCount() > 0)
        throw new Error('WebAuthn RP ID hostname changed while credentials exist');
      else if (current.rp_id !== this.relyingParty.rpId)
        this.statements
          .prepare('UPDATE auth_settings SET rp_id = ? WHERE singleton = 1')
          .run(this.relyingParty.rpId);
      return { id: OWNER_ID, userHandle: new Uint8Array(current?.user_handle ?? userHandle) };
    });
  }
  readOwner(): LocalOwner | null {
    const row = this.statements
      .prepare('SELECT user_handle FROM auth_settings WHERE singleton = 1')
      .get() as { user_handle: Uint8Array } | undefined;
    return row ? { id: OWNER_ID, userHandle: new Uint8Array(row.user_handle) } : null;
  }
  listAuthorizedDevices(): readonly AuthorizedDevice[] {
    return (
      this.statements
        .prepare('SELECT * FROM auth_devices ORDER BY created_at, id')
        .all() as DeviceRow[]
    ).map(toDevice);
  }
  claimFirstDevice(owner: LocalOwner, device: AuthorizedDevice): 'claimed' | 'alreadyClaimed' {
    if (owner.id !== OWNER_ID || !this.readOwner())
      throw new Error('Local owner is not initialized');
    return withImmediateTransaction(this.db, () => {
      if (this.deviceCount()) return 'alreadyClaimed';
      this.insertDevice(device);
      return 'claimed';
    });
  }
  authorizeDevice(
    device: AuthorizedDevice,
  ): 'authorized' | 'notAuthorized' | 'duplicateCredential' {
    try {
      return withImmediateTransaction(this.db, () => {
        if (!this.readOwner() || !this.deviceCount()) return 'notAuthorized';
        this.insertDevice(device);
        return 'authorized';
      });
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed: auth_devices.credential_id'))
        return 'duplicateCredential';
      throw error;
    }
  }
  findDeviceByCredentialId(id: AuthorizedDevice['credentialId']): AuthorizedDevice | null {
    const row = this.statements
      .prepare('SELECT * FROM auth_devices WHERE credential_id = ?')
      .get(id) as DeviceRow | undefined;
    return row ? toDevice(row) : null;
  }
  findDevice(id: AuthorizedDevice['id']): AuthorizedDevice | null {
    const row = this.statements.prepare('SELECT * FROM auth_devices WHERE id = ?').get(id) as
      DeviceRow | undefined;
    return row ? toDevice(row) : null;
  }
  renameDevice(
    id: AuthorizedDevice['id'],
    expectedVersion: number,
    nickname: AuthorizedDevice['nickname'],
  ): 'renamed' | 'stale' | 'notFound' {
    return withImmediateTransaction(this.db, () => {
      const result = this.statements
        .prepare(
          'UPDATE auth_devices SET nickname = ?, version = version + 1 WHERE id = ? AND version = ?',
        )
        .run(nickname, id, expectedVersion);
      if (result.changes) return 'renamed';
      const outcome = this.findDevice(id) ? 'stale' : 'notFound';
      return outcome;
    });
  }
  advanceCounter(
    id: AuthorizedDevice['id'],
    expected: number,
    expectedVersion: number,
    next: number,
    usedAt: string,
  ): boolean {
    const zeroSynced =
      this.statements
        .prepare(
          "UPDATE auth_devices SET last_used_at = ?, version = version + 1 WHERE id = ? AND counter = ? AND version = ? AND ? = 0 AND device_type = 'multiDevice'",
        )
        .run(usedAt, id, expected, expectedVersion, next).changes === 1;
    return (
      zeroSynced ||
      this.statements
        .prepare(
          'UPDATE auth_devices SET counter = ?, last_used_at = ?, version = version + 1 WHERE id = ? AND counter = ? AND version = ? AND ? > counter',
        )
        .run(next, usedAt, id, expected, expectedVersion, next).changes === 1
    );
  }
  revokeDevice(
    id: AuthorizedDevice['id'],
    revokedAt: string,
  ): 'revoked' | 'finalDevice' | 'notFound' {
    return withImmediateTransaction(this.db, () => {
      if (!this.findDevice(id)) return 'notFound';
      if (this.deviceCount() < 2) return 'finalDevice';
      this.statements
        .prepare(
          'UPDATE auth_sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL',
        )
        .run(revokedAt, id);
      this.statements.prepare('DELETE FROM auth_devices WHERE id = ?').run(id);
      return 'revoked';
    });
  }
  saveCeremony(
    token: PasskeyCeremony['id'],
    ceremony: Omit<PasskeyCeremony, 'id'> & {
      challenge: Uint8Array;
      expectedOrigin: string;
      rpId: string;
      enrollmentTicket?: EnrollmentTicket['id'];
    },
    now?: string,
  ): void {
    withImmediateTransaction(this.db, () => {
      // Admission and cleanup share one immediate transaction, so separate
      // processes cannot both observe the same remaining slot.
      this.statements.prepare('DELETE FROM auth_ceremonies WHERE consumed_at IS NOT NULL').run();
      if (now)
        this.statements.prepare('DELETE FROM auth_ceremonies WHERE expires_at <= ?').run(now);
      const active = this.statements
        .prepare('SELECT count(*) AS count FROM auth_ceremonies WHERE consumed_at IS NULL')
        .get() as { count: number };
      if (active.count >= 64) throw new CeremonyCapacityError('Ceremony capacity reached');
      this.statements
        .prepare(
          'INSERT INTO auth_ceremonies (token_hash, purpose, challenge, expected_origin, rp_id, expires_at, ticket_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          hash(token),
          ceremony.purpose,
          ceremony.challenge,
          ceremony.expectedOrigin,
          ceremony.rpId,
          ceremony.expiresAt,
          ceremony.enrollmentTicket ? hash(ceremony.enrollmentTicket) : null,
        );
    });
  }
  consumeCeremony(
    token: PasskeyCeremony['id'],
    now: string,
  ): (PasskeyCeremony & { challenge: Uint8Array; expectedOrigin: string; rpId: string }) | null {
    return withImmediateTransaction(this.db, () => {
      const row = this.statements
        .prepare(
          'UPDATE auth_ceremonies SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING purpose, challenge, expected_origin, rp_id, expires_at',
        )
        .get(now, hash(token), now) as CeremonyRow | undefined;
      return row
        ? {
            id: passkeyCeremonyId(token),
            purpose: row.purpose as PasskeyCeremony['purpose'],
            challenge: new Uint8Array(row.challenge),
            expectedOrigin: row.expected_origin,
            rpId: row.rp_id,
            expiresAt: row.expires_at,
          }
        : null;
    });
  }
  readCeremony(
    token: PasskeyCeremony['id'],
    now: string,
  ): (PasskeyCeremony & { challenge: Uint8Array; expectedOrigin: string; rpId: string }) | null {
    const row = this.statements
      .prepare(
        'SELECT purpose, challenge, expected_origin, rp_id, expires_at FROM auth_ceremonies WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?',
      )
      .get(hash(token), now) as CeremonyRow | undefined;
    return row
      ? {
          id: passkeyCeremonyId(token),
          purpose: row.purpose as PasskeyCeremony['purpose'],
          challenge: new Uint8Array(row.challenge),
          expectedOrigin: row.expected_origin,
          rpId: row.rp_id,
          expiresAt: row.expires_at,
        }
      : null;
  }
  saveTicket(token: EnrollmentTicket['id'], ticket: Omit<EnrollmentTicket, 'id'>): void {
    this.statements
      .prepare('INSERT INTO auth_tickets (token_hash, expires_at, consumed_at) VALUES (?, ?, NULL)')
      .run(hash(token), ticket.expiresAt);
  }
  issueEnrollmentTicket(
    token: EnrollmentTicket['id'],
    creatorSession: AuthorizationSession['id'],
    expiresAt: string,
  ): void {
    withImmediateTransaction(this.db, () => {
      const creator = hash(creatorSession);
      this.statements
        .prepare('DELETE FROM auth_tickets WHERE creator_session_hash = ? AND consumed_at IS NULL')
        .run(creator);
      this.statements
        .prepare(
          'INSERT INTO auth_tickets (token_hash, expires_at, consumed_at, creator_session_hash) VALUES (?, ?, NULL, ?)',
        )
        .run(hash(token), expiresAt, creator);
    });
  }
  enrollmentTicketStatus(
    creatorSession: AuthorizationSession['id'],
    now: string,
  ): 'none' | 'pending' | 'used' | 'expired' {
    const row = this.statements
      .prepare(
        'SELECT expires_at, consumed_at FROM auth_tickets WHERE creator_session_hash = ? ORDER BY rowid DESC LIMIT 1',
      )
      .get(hash(creatorSession)) as { expires_at: string; consumed_at: string | null } | undefined;
    if (!row) return 'none';
    if (row.consumed_at) return 'used';
    return row.expires_at > now ? 'pending' : 'expired';
  }
  cancelEnrollmentTicket(creatorSession: AuthorizationSession['id'], now: string): boolean {
    return withImmediateTransaction(this.db, () => {
      const result = this.statements
        .prepare(
          'DELETE FROM auth_tickets WHERE rowid = (SELECT rowid FROM auth_tickets WHERE creator_session_hash = ? AND consumed_at IS NULL AND expires_at > ? ORDER BY rowid DESC LIMIT 1)',
        )
        .run(hash(creatorSession), now);
      return result.changes === 1;
    });
  }
  consumeTicket(token: EnrollmentTicket['id'], now: string): boolean {
    return this.consume('auth_tickets', token, now);
  }
  ticketAvailable(token: EnrollmentTicket['id'], now: string): boolean {
    return Boolean(
      this.statements
        .prepare(
          'SELECT 1 FROM auth_tickets t WHERE t.token_hash = ? AND t.consumed_at IS NULL AND t.expires_at > ? AND (t.creator_session_hash IS NULL OR EXISTS (SELECT 1 FROM auth_sessions s WHERE s.token_hash = t.creator_session_hash AND s.revoked_at IS NULL AND s.expires_at > ?))',
        )
        .get(hash(token), now, now),
    );
  }
  completeRegistration(input: {
    ceremony: PasskeyCeremony['id'];
    now: string;
    device: AuthorizedDevice;
    session: AuthorizationSession;
  }):
    | 'registered'
    | 'bootstrapAlreadyClaimed'
    | 'ticketUnavailable'
    | 'duplicateCredential'
    | 'ceremonyUnavailable' {
    if (input.session.deviceId !== input.device.id)
      throw new Error('AUTHORIZATION_SESSION_DEVICE_MISMATCH');
    try {
      return withImmediateTransaction(this.db, () => {
        const ceremony = this.statements
          .prepare(
            'SELECT ticket_hash FROM auth_ceremonies WHERE token_hash = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?',
          )
          .get(hash(input.ceremony), 'registration', input.now) as
          { ticket_hash: string | null } | undefined;
        if (!ceremony) return 'ceremonyUnavailable';
        if (ceremony.ticket_hash) {
          const result = this.statements
            .prepare(
              'UPDATE auth_tickets SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ? AND (creator_session_hash IS NULL OR EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash = auth_tickets.creator_session_hash AND revoked_at IS NULL AND expires_at > ?))',
            )
            .run(input.now, ceremony.ticket_hash, input.now, input.now);
          if (result.changes !== 1) return 'ticketUnavailable';
        } else if (this.deviceCount() !== 0) return 'bootstrapAlreadyClaimed';
        this.insertDevice(input.device);
        this.statements
          .prepare('INSERT INTO auth_sessions (token_hash, device_id, expires_at) VALUES (?, ?, ?)')
          .run(hash(input.session.id), input.session.deviceId, input.session.expiresAt);
        this.statements
          .prepare('UPDATE auth_ceremonies SET consumed_at = ? WHERE token_hash = ?')
          .run(input.now, hash(input.ceremony));
        return 'registered';
      });
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed: auth_devices.credential_id'))
        return 'duplicateCredential';
      throw error;
    }
  }
  completeAuthentication(input: {
    ceremony: PasskeyCeremony['id'];
    now: string;
    device: AuthorizedDevice;
    nextCounter: number;
    session: AuthorizationSession;
  }): boolean {
    if (input.session.deviceId !== input.device.id)
      throw new Error('AUTHORIZATION_SESSION_DEVICE_MISMATCH');
    return withImmediateTransaction(this.db, () => {
      const ceremony = this.statements
        .prepare(
          'SELECT 1 FROM auth_ceremonies WHERE token_hash = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?',
        )
        .get(hash(input.ceremony), 'authentication', input.now);
      if (!ceremony) return false;
      const updated = this.advanceCounter(
        input.device.id,
        input.device.counter,
        input.device.version ?? 0,
        input.nextCounter,
        input.now,
      );
      if (!updated) return false;
      this.statements
        .prepare('INSERT INTO auth_sessions (token_hash, device_id, expires_at) VALUES (?, ?, ?)')
        .run(hash(input.session.id), input.session.deviceId, input.session.expiresAt);
      this.statements
        .prepare('UPDATE auth_ceremonies SET consumed_at = ? WHERE token_hash = ?')
        .run(input.now, hash(input.ceremony));
      return true;
    });
  }
  saveSession(token: AuthorizationSession['id'], session: Omit<AuthorizationSession, 'id'>): void {
    this.statements
      .prepare('INSERT INTO auth_sessions (token_hash, device_id, expires_at) VALUES (?, ?, ?)')
      .run(hash(token), session.deviceId, session.expiresAt);
  }
  sessionDevice(token: AuthorizationSession['id'], now: string): AuthorizedDevice['id'] | null {
    const row = this.statements
      .prepare(
        'SELECT device_id FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?',
      )
      .get(hash(token), now) as { device_id: string | null } | undefined;
    return row?.device_id ? authorizedDeviceId(row.device_id) : null;
  }
  revokeSession(token: AuthorizationSession['id'], now: string): boolean {
    return (
      this.statements
        .prepare(
          'UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
        )
        .run(now, hash(token)).changes === 1
    );
  }
  close(): void {
    this.db.close();
  }
  private insertDevice(device: AuthorizedDevice): void {
    this.statements
      .prepare(
        'INSERT INTO auth_devices (id, credential_id, public_key, counter, transports_json, device_type, backed_up, nickname, created_at, last_used_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        device.id,
        device.credentialId,
        device.publicKey,
        device.counter,
        JSON.stringify(device.transports),
        device.deviceType,
        device.backedUp ? 1 : 0,
        device.nickname,
        device.createdAt,
        device.lastUsedAt ?? null,
        device.version ?? 0,
      );
  }
  private consume(table: 'auth_tickets', token: string, now: string): boolean {
    return withImmediateTransaction(this.db, () => {
      const changes = this.db
        .prepare(
          `UPDATE ${table} SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .run(now, hash(token), now).changes;
      return changes === 1;
    });
  }
  private deviceCount(): number {
    return (
      this.statements.prepare('SELECT COUNT(*) AS count FROM auth_devices').get() as {
        count: number;
      }
    ).count;
  }
}
type DeviceRow = {
  id: string;
  credential_id: string;
  public_key: Uint8Array;
  counter: number;
  transports_json: string;
  device_type: AuthorizedDevice['deviceType'];
  backed_up: number;
  nickname: string;
  created_at: string;
  last_used_at: string | null;
  version: number;
};
type CeremonyRow = {
  purpose: string;
  challenge: Uint8Array;
  expected_origin: string;
  rp_id: string;
  expires_at: string;
};
function toDevice(row: DeviceRow): AuthorizedDevice {
  return {
    id: authorizedDeviceId(row.id),
    credentialId: webAuthnCredentialId(row.credential_id),
    publicKey: new Uint8Array(row.public_key),
    counter: row.counter,
    transports: JSON.parse(row.transports_json),
    deviceType: row.device_type,
    backedUp: row.backed_up === 1,
    nickname: deviceNickname(row.nickname),
    createdAt: row.created_at,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    version: row.version,
  };
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isLocked(error: unknown): boolean {
  return error instanceof Error && /database is locked/i.test(error.message);
}
