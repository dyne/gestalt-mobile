/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { authorizedDeviceId, authorizationSessionId, enrollmentTicketId, localOwnerId, passkeyCeremonyId, webAuthnCredentialId } from '../../features/auth/domain/identifiers.js';
import { deviceNickname } from '../../features/auth/domain/device-nickname.js';
import type { AuthorizedDevice, LocalOwner } from '../../features/auth/domain/authorization.js';
import { authorizationDatabasePath, SqliteAuthorizationStore } from './sqlite-authorization-store.js';

const paths: string[] = [];
const rp = { publicOrigin: 'https://gestalt.example:8443', rpId: 'gestalt.example', rpName: 'Gestalt Mobile' as const };
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function home() { const value = await mkdtemp(join(tmpdir(), 'gestalt-auth-')); paths.push(value); return value; }
function owner(): LocalOwner { return { id: localOwnerId('local-owner'), userHandle: new Uint8Array([1, 2, 3]) }; }
function device(id: string, credential = `credential-${id}`, overrides: Partial<AuthorizedDevice> = {}): AuthorizedDevice { return { id: authorizedDeviceId(id), credentialId: webAuthnCredentialId(credential), publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'], deviceType: 'singleDevice', backedUp: false, nickname: deviceNickname(`Device ${id}`), createdAt: '2026-08-02T00:00:00.000Z', version: 0, ...overrides }; }

describe('SqliteAuthorizationStore', () => {
  it('creates a 0700 shared boundary, initializes one owner, and persists allowed hostname changes before credentials', async () => {
    const directory = await home(); const first = new SqliteAuthorizationStore(directory, rp);
    expect(authorizationDatabasePath(directory)).toBe(join(directory, '.codex-gestalt', 'gestalt-mobile', 'auth.sqlite'));
    expect(first.initializeOwner(owner().userHandle).userHandle).toEqual(owner().userHandle);
    expect((await stat(join(directory, '.codex-gestalt', 'gestalt-mobile'))).mode & 0o777).toBe(0o700); first.close();
    const second = new SqliteAuthorizationStore(directory, { ...rp, publicOrigin: 'https://other.example:9443', rpId: 'other.example' });
    expect(second.initializeOwner(new Uint8Array([9])).userHandle).toEqual(owner().userHandle); second.close();
  });

  it('round-trips every device field and atomically guards bootstrap and authorized additions', async () => {
    const directory = await home(); const store = new SqliteAuthorizationStore(directory, rp); store.initializeOwner(owner().userHandle);
    const first = device('one', 'credential-one', { publicKey: new Uint8Array([9, 8]), transports: ['usb', 'hybrid'], deviceType: 'multiDevice', backedUp: true, lastUsedAt: '2026-08-02T01:00:00.000Z' });
    expect(store.claimFirstDevice(owner(), first)).toBe('claimed'); expect(store.claimFirstDevice(owner(), device('two'))).toBe('alreadyClaimed');
    expect(store.authorizeDevice(device('two'))).toBe('authorized'); expect(store.authorizeDevice(device('three', 'credential-two'))).toBe('duplicateCredential');
    expect(store.findDevice(first.id)).toEqual(first); store.close();
  });

  it('hashes one-time tokens, rejects replay and expiry, and never persists raw artifacts', async () => {
    const directory = await home(); const store = new SqliteAuthorizationStore(directory, rp); store.initializeOwner(owner().userHandle);
    store.saveCeremony(passkeyCeremonyId('raw-ceremony'), { purpose: 'registration', challenge: new Uint8Array([5]), expectedOrigin: rp.publicOrigin, rpId: rp.rpId, expiresAt: '2026-08-03T00:00:00.000Z' });
    expect(store.consumeCeremony(passkeyCeremonyId('raw-ceremony'), '2026-08-02T00:00:00.000Z')).toMatchObject({ challenge: new Uint8Array([5]), expectedOrigin: rp.publicOrigin });
    expect(store.consumeCeremony(passkeyCeremonyId('raw-ceremony'), '2026-08-02T00:00:01.000Z')).toBeNull();
    store.saveTicket(enrollmentTicketId('raw-ticket'), { expiresAt: '2026-08-01T00:00:00.000Z' }); expect(store.consumeTicket(enrollmentTicketId('raw-ticket'), '2026-08-02T00:00:00.000Z')).toBe(false);
    store.close(); expect((await readFile(authorizationDatabasePath(directory))).includes('raw-ceremony')).toBe(false); expect((await readFile(authorizationDatabasePath(directory))).includes('raw-ticket')).toBe(false);
  });

  it('uses CAS for stale writers and preserves zero-counter multi-device assertions', async () => {
    const directory = await home(); const first = new SqliteAuthorizationStore(directory, rp); const second = new SqliteAuthorizationStore(directory, rp); first.initializeOwner(owner().userHandle);
    const synced = device('one', 'credential-one', { deviceType: 'multiDevice', backedUp: true }); expect(first.claimFirstDevice(owner(), synced)).toBe('claimed');
    expect(first.renameDevice(synced.id, 0, deviceNickname('Renamed'))).toBe('renamed'); expect(second.renameDevice(synced.id, 0, deviceNickname('Lost update'))).toBe('stale');
    expect(second.advanceCounter(synced.id, 0, 1, 0, '2026-08-02T01:00:00.000Z')).toBe(true);
    expect(first.advanceCounter(synced.id, 0, 1, 0, '2026-08-02T02:00:00.000Z')).toBe(false);
    expect(first.findDevice(synced.id)).toMatchObject({ counter: 0, lastUsedAt: '2026-08-02T01:00:00.000Z', version: 2 });
    first.close(); second.close();
  });

  it('revokes all sessions durably, removes the device, and preserves exactly one final device under races', async () => {
    const directory = await home(); const first = new SqliteAuthorizationStore(directory, rp); const second = new SqliteAuthorizationStore(directory, rp); first.initializeOwner(owner().userHandle);
    const one = device('one'); const two = device('two'); expect(first.claimFirstDevice(owner(), one)).toBe('claimed'); expect(first.authorizeDevice(two)).toBe('authorized');
    first.saveSession(authorizationSessionId('one-a'), { deviceId: one.id, expiresAt: '2026-09-01T00:00:00.000Z' }); first.saveSession(authorizationSessionId('one-b'), { deviceId: one.id, expiresAt: '2026-09-01T00:00:00.000Z' });
    expect(second.revokeDevice(one.id, '2026-08-02T01:00:00.000Z')).toBe('revoked'); expect(first.findDevice(one.id)).toBeNull(); expect(first.sessionDevice(authorizationSessionId('one-a'), '2026-08-02T02:00:00.000Z')).toBeNull(); expect(second.sessionDevice(authorizationSessionId('one-b'), '2026-08-02T02:00:00.000Z')).toBeNull();
    expect(first.revokeDevice(two.id, '2026-08-02T02:00:00.000Z')).toBe('finalDevice'); expect(first.listAuthorizedDevices()).toHaveLength(1);
    first.close(); second.close();
  });

  it('rejects RP hostname changes after credentials and keeps schema initialization idempotent', async () => {
    const directory = await home(); const store = new SqliteAuthorizationStore(directory, rp); store.initializeOwner(owner().userHandle); expect(store.claimFirstDevice(owner(), device('one'))).toBe('claimed'); store.close();
    expect(() => new SqliteAuthorizationStore(directory, { ...rp, publicOrigin: 'https://other.example', rpId: 'other.example' })).toThrow('hostname changed');
    const same = new SqliteAuthorizationStore(directory, { ...rp, publicOrigin: 'https://gestalt.example:9443' }); expect(same.readOwner()).not.toBeNull(); same.close();
  });

  it('allows exactly one competing revocation from a two-device starting state', async () => {
    const directory = await home(); const first = new SqliteAuthorizationStore(directory, rp); const second = new SqliteAuthorizationStore(directory, rp); first.initializeOwner(owner().userHandle);
    const one = device('one'); const two = device('two'); first.claimFirstDevice(owner(), one); first.authorizeDevice(two);
    expect(first.revokeDevice(one.id, '2026-08-02T01:00:00.000Z')).toBe('revoked'); expect(second.revokeDevice(two.id, '2026-08-02T01:00:00.000Z')).toBe('finalDevice'); expect(second.listAuthorizedDevices()).toHaveLength(1);
    first.close(); second.close();
  });

  it('refuses an empty injected owner handle', async () => {
    const store = new SqliteAuthorizationStore(await home(), rp); expect(() => store.initializeOwner(new Uint8Array())).toThrow('must not be empty'); store.close();
  });
});
