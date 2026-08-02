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
import type { AuthorizationSession, AuthorizedDevice, EnrollmentTicket, LocalOwner, PasskeyCeremony } from '../../features/auth/domain/authorization.js';
import { authorizedDeviceId, localOwnerId, passkeyCeremonyId, webAuthnCredentialId } from '../../features/auth/domain/identifiers.js';
import { deviceNickname } from '../../features/auth/domain/device-nickname.js';

const OWNER_ID = localOwnerId('local-owner');
const SCHEMA_VERSION = 1;

export function authorizationDatabasePath(homeDirectory: string): string {
  return join(resolve(homeDirectory), '.codex-gestalt', 'gestalt-mobile', 'auth.sqlite');
}

/** SQLite adapter for the auth bounded context. No SQLite types escape this file. */
export class SqliteAuthorizationStore implements AuthorizationRepository {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly relyingParty: RelyingPartyConfig;

  constructor(homeDirectory: string, relyingParty: RelyingPartyConfig) {
    this.path = authorizationDatabasePath(homeDirectory);
    const parent = dirname(this.path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
    this.relyingParty = relyingParty;
    this.db = new DatabaseSync(this.path);
    try {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      this.db.exec(`CREATE TABLE IF NOT EXISTS auth_settings (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL, rp_id TEXT NOT NULL, user_handle BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS auth_devices (id TEXT PRIMARY KEY, credential_id TEXT NOT NULL UNIQUE, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports_json TEXT NOT NULL, device_type TEXT NOT NULL, backed_up INTEGER NOT NULL CHECK(backed_up IN (0,1)), nickname TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS auth_ceremonies (token_hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, challenge BLOB NOT NULL, expected_origin TEXT NOT NULL, rp_id TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT);
CREATE TABLE IF NOT EXISTS auth_tickets (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, consumed_at TEXT);
CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, device_id TEXT REFERENCES auth_devices(id) ON DELETE SET NULL, expires_at TEXT NOT NULL, revoked_at TEXT);`);
    const settings = this.db.prepare('SELECT rp_id FROM auth_settings WHERE singleton = 1').get() as { rp_id: string } | undefined;
      if (settings && settings.rp_id !== relyingParty.rpId && this.deviceCount() > 0)
        throw new Error('WebAuthn RP ID hostname changed while credentials exist');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  initializeOwner(userHandle: Uint8Array): LocalOwner {
    if (userHandle.length === 0) throw new Error('Local owner handle must not be empty');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT user_handle, rp_id FROM auth_settings WHERE singleton = 1').get() as { user_handle: Uint8Array; rp_id: string } | undefined;
      if (!current) this.db.prepare('INSERT INTO auth_settings (singleton, schema_version, rp_id, user_handle) VALUES (1, ?, ?, ?)').run(SCHEMA_VERSION, this.relyingParty.rpId, userHandle);
      else if (current.rp_id !== this.relyingParty.rpId && this.deviceCount() > 0) throw new Error('WebAuthn RP ID hostname changed while credentials exist');
      else if (current.rp_id !== this.relyingParty.rpId) this.db.prepare('UPDATE auth_settings SET rp_id = ? WHERE singleton = 1').run(this.relyingParty.rpId);
      this.db.exec('COMMIT');
      return { id: OWNER_ID, userHandle: new Uint8Array(current?.user_handle ?? userHandle) };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  readOwner(): LocalOwner | null { const row = this.db.prepare('SELECT user_handle FROM auth_settings WHERE singleton = 1').get() as { user_handle: Uint8Array } | undefined; return row ? { id: OWNER_ID, userHandle: new Uint8Array(row.user_handle) } : null; }
  listAuthorizedDevices(): readonly AuthorizedDevice[] { return (this.db.prepare('SELECT * FROM auth_devices ORDER BY created_at, id').all() as DeviceRow[]).map(toDevice); }
  claimFirstDevice(owner: LocalOwner, device: AuthorizedDevice): 'claimed' | 'alreadyClaimed' {
    if (owner.id !== OWNER_ID || !this.readOwner()) throw new Error('Local owner is not initialized');
    this.db.exec('BEGIN IMMEDIATE'); try { if (this.deviceCount()) { this.db.exec('COMMIT'); return 'alreadyClaimed'; } this.insertDevice(device); this.db.exec('COMMIT'); return 'claimed'; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  authorizeDevice(device: AuthorizedDevice): 'authorized' | 'notAuthorized' | 'duplicateCredential' {
    this.db.exec('BEGIN IMMEDIATE'); try { if (!this.readOwner() || !this.deviceCount()) { this.db.exec('COMMIT'); return 'notAuthorized'; } try { this.insertDevice(device); } catch (error) { if (String(error).includes('UNIQUE constraint failed: auth_devices.credential_id')) { this.db.exec('ROLLBACK'); return 'duplicateCredential'; } throw error; } this.db.exec('COMMIT'); return 'authorized'; } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }
  findDeviceByCredentialId(id: AuthorizedDevice['credentialId']): AuthorizedDevice | null { const row = this.db.prepare('SELECT * FROM auth_devices WHERE credential_id = ?').get(id) as DeviceRow | undefined; return row ? toDevice(row) : null; }
  findDevice(id: AuthorizedDevice['id']): AuthorizedDevice | null { const row = this.db.prepare('SELECT * FROM auth_devices WHERE id = ?').get(id) as DeviceRow | undefined; return row ? toDevice(row) : null; }
  renameDevice(id: AuthorizedDevice['id'], expectedVersion: number, nickname: AuthorizedDevice['nickname']): 'renamed' | 'stale' | 'notFound' { const result = this.db.prepare('UPDATE auth_devices SET nickname = ?, version = version + 1 WHERE id = ? AND version = ?').run(nickname, id, expectedVersion); if (result.changes) return 'renamed'; return this.findDevice(id) ? 'stale' : 'notFound'; }
  advanceCounter(id: AuthorizedDevice['id'], expected: number, expectedVersion: number, next: number, usedAt: string): boolean { const zeroSynced = this.db.prepare("UPDATE auth_devices SET last_used_at = ?, version = version + 1 WHERE id = ? AND counter = ? AND version = ? AND ? = 0 AND device_type = 'multiDevice'").run(usedAt, id, expected, expectedVersion, next).changes === 1; return zeroSynced || this.db.prepare('UPDATE auth_devices SET counter = ?, last_used_at = ?, version = version + 1 WHERE id = ? AND counter = ? AND version = ? AND ? > counter').run(next, usedAt, id, expected, expectedVersion, next).changes === 1; }
  revokeDevice(id: AuthorizedDevice['id'], revokedAt: string): 'revoked' | 'finalDevice' | 'notFound' { this.db.exec('BEGIN IMMEDIATE'); try { if (!this.findDevice(id)) { this.db.exec('COMMIT'); return 'notFound'; } if (this.deviceCount() < 2) { this.db.exec('COMMIT'); return 'finalDevice'; } this.db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(revokedAt, id); this.db.prepare('DELETE FROM auth_devices WHERE id = ?').run(id); this.db.exec('COMMIT'); return 'revoked'; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  saveCeremony(token: PasskeyCeremony['id'], ceremony: Omit<PasskeyCeremony, 'id'> & { challenge: Uint8Array; expectedOrigin: string; rpId: string }): void { this.db.prepare('INSERT INTO auth_ceremonies (token_hash, purpose, challenge, expected_origin, rp_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(hash(token), ceremony.purpose, ceremony.challenge, ceremony.expectedOrigin, ceremony.rpId, ceremony.expiresAt); }
  consumeCeremony(token: PasskeyCeremony['id'], now: string): (PasskeyCeremony & { challenge: Uint8Array; expectedOrigin: string; rpId: string }) | null { this.db.exec('BEGIN IMMEDIATE'); try { const row = this.db.prepare('UPDATE auth_ceremonies SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING purpose, challenge, expected_origin, rp_id, expires_at').get(now, hash(token), now) as CeremonyRow | undefined; this.db.exec('COMMIT'); return row ? { id: passkeyCeremonyId(token), purpose: row.purpose as PasskeyCeremony['purpose'], challenge: new Uint8Array(row.challenge), expectedOrigin: row.expected_origin, rpId: row.rp_id, expiresAt: row.expires_at } : null; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  saveTicket(token: EnrollmentTicket['id'], ticket: Omit<EnrollmentTicket, 'id'>): void { this.db.prepare('INSERT INTO auth_tickets (token_hash, expires_at, consumed_at) VALUES (?, ?, NULL)').run(hash(token), ticket.expiresAt); }
  consumeTicket(token: EnrollmentTicket['id'], now: string): boolean { return this.consume('auth_tickets', token, now); }
  saveSession(token: AuthorizationSession['id'], session: Omit<AuthorizationSession, 'id'>): void { this.db.prepare('INSERT INTO auth_sessions (token_hash, device_id, expires_at) VALUES (?, ?, ?)').run(hash(token), session.deviceId, session.expiresAt); }
  sessionDevice(token: AuthorizationSession['id'], now: string): AuthorizedDevice['id'] | null { const row = this.db.prepare('SELECT device_id FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?').get(hash(token), now) as { device_id: string | null } | undefined; return row?.device_id ? authorizedDeviceId(row.device_id) : null; }
  close(): void { this.db.close(); }
  private insertDevice(device: AuthorizedDevice): void { this.db.prepare('INSERT INTO auth_devices (id, credential_id, public_key, counter, transports_json, device_type, backed_up, nickname, created_at, last_used_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(device.id, device.credentialId, device.publicKey, device.counter, JSON.stringify(device.transports), device.deviceType, device.backedUp ? 1 : 0, device.nickname, device.createdAt, device.lastUsedAt ?? null, device.version ?? 0); }
  private consume(table: 'auth_tickets', token: string, now: string): boolean { this.db.exec('BEGIN IMMEDIATE'); try { const changes = this.db.prepare(`UPDATE ${table} SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`).run(now, hash(token), now).changes; this.db.exec('COMMIT'); return changes === 1; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  private deviceCount(): number { return (this.db.prepare('SELECT COUNT(*) AS count FROM auth_devices').get() as { count: number }).count; }
}
type DeviceRow = { id: string; credential_id: string; public_key: Uint8Array; counter: number; transports_json: string; device_type: AuthorizedDevice['deviceType']; backed_up: number; nickname: string; created_at: string; last_used_at: string | null; version: number };
type CeremonyRow = { purpose: string; challenge: Uint8Array; expected_origin: string; rp_id: string; expires_at: string };
function toDevice(row: DeviceRow): AuthorizedDevice { return { id: authorizedDeviceId(row.id), credentialId: webAuthnCredentialId(row.credential_id), publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports_json), deviceType: row.device_type, backedUp: row.backed_up === 1, nickname: deviceNickname(row.nickname), createdAt: row.created_at, ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}), version: row.version }; }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
