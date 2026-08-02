/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  authorizedDeviceId,
  authorizationSessionId,
  enrollmentTicketId,
  localOwnerId,
  passkeyCeremonyId,
  webAuthnCredentialId,
} from '../../features/auth/domain/identifiers.js';
import { deviceNickname } from '../../features/auth/domain/device-nickname.js';
import type { AuthorizedDevice, LocalOwner } from '../../features/auth/domain/authorization.js';
import {
  authorizationDatabasePath,
  SqliteAuthorizationStore,
} from './sqlite-authorization-store.js';

const paths: string[] = [];
const rp = {
  publicOrigin: 'https://gestalt.example:8443',
  rpId: 'gestalt.example',
  rpName: 'Gestalt Mobile' as const,
};
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function home() {
  const value = await mkdtemp(join(tmpdir(), 'gestalt-auth-'));
  paths.push(value);
  return value;
}
function owner(): LocalOwner {
  return { id: localOwnerId('local-owner'), userHandle: new Uint8Array([1, 2, 3]) };
}
function device(
  id: string,
  credential = `credential-${id}`,
  overrides: Partial<AuthorizedDevice> = {},
): AuthorizedDevice {
  return {
    id: authorizedDeviceId(id),
    credentialId: webAuthnCredentialId(credential),
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: ['internal'],
    deviceType: 'singleDevice',
    backedUp: false,
    nickname: deviceNickname(`Device ${id}`),
    createdAt: '2026-08-02T00:00:00.000Z',
    version: 0,
    ...overrides,
  };
}

describe('SqliteAuthorizationStore', () => {
  it('creates a 0700 shared boundary, initializes one owner, and persists allowed hostname changes before credentials', async () => {
    const directory = await home();
    const first = new SqliteAuthorizationStore(directory, rp);
    expect(authorizationDatabasePath(directory)).toBe(
      join(directory, '.codex-gestalt', 'gestalt-mobile', 'auth.sqlite'),
    );
    expect(first.initializeOwner(owner().userHandle).userHandle).toEqual(owner().userHandle);
    expect((await stat(join(directory, '.codex-gestalt', 'gestalt-mobile'))).mode & 0o777).toBe(
      0o700,
    );
    first.close();
    const second = new SqliteAuthorizationStore(directory, {
      ...rp,
      publicOrigin: 'https://other.example:9443',
      rpId: 'other.example',
    });
    expect(second.initializeOwner(new Uint8Array([9])).userHandle).toEqual(owner().userHandle);
    second.close();
  });

  it('round-trips every device field and atomically guards bootstrap and authorized additions', async () => {
    const directory = await home();
    const store = new SqliteAuthorizationStore(directory, rp);
    store.initializeOwner(owner().userHandle);
    const first = device('one', 'credential-one', {
      publicKey: new Uint8Array([9, 8]),
      transports: ['usb', 'hybrid'],
      deviceType: 'multiDevice',
      backedUp: true,
      lastUsedAt: '2026-08-02T01:00:00.000Z',
    });
    expect(store.claimFirstDevice(owner(), first)).toBe('claimed');
    expect(store.claimFirstDevice(owner(), device('two'))).toBe('alreadyClaimed');
    expect(store.authorizeDevice(device('two'))).toBe('authorized');
    expect(store.authorizeDevice(device('three', 'credential-two'))).toBe('duplicateCredential');
    expect(store.findDevice(first.id)).toEqual(first);
    store.close();
  });

  it('hashes one-time tokens, rejects replay and expiry, and never persists raw artifacts', async () => {
    const directory = await home();
    const store = new SqliteAuthorizationStore(directory, rp);
    store.initializeOwner(owner().userHandle);
    store.saveCeremony(passkeyCeremonyId('raw-ceremony'), {
      purpose: 'registration',
      challenge: new Uint8Array([5]),
      expectedOrigin: rp.publicOrigin,
      rpId: rp.rpId,
      expiresAt: '2026-08-03T00:00:00.000Z',
    });
    expect(
      store.consumeCeremony(passkeyCeremonyId('raw-ceremony'), '2026-08-02T00:00:00.000Z'),
    ).toMatchObject({ challenge: new Uint8Array([5]), expectedOrigin: rp.publicOrigin });
    expect(
      store.consumeCeremony(passkeyCeremonyId('raw-ceremony'), '2026-08-02T00:00:01.000Z'),
    ).toBeNull();
    store.saveTicket(enrollmentTicketId('raw-ticket'), { expiresAt: '2026-08-01T00:00:00.000Z' });
    expect(store.consumeTicket(enrollmentTicketId('raw-ticket'), '2026-08-02T00:00:00.000Z')).toBe(
      false,
    );
    store.close();
    expect((await readFile(authorizationDatabasePath(directory))).includes('raw-ceremony')).toBe(
      false,
    );
    expect((await readFile(authorizationDatabasePath(directory))).includes('raw-ticket')).toBe(
      false,
    );
  });

  it('atomically completes a bootstrap or ticket-bound registration without consuming artifacts on failed preconditions', async () => {
    const directory = await home();
    const store = new SqliteAuthorizationStore(directory, rp);
    store.initializeOwner(owner().userHandle);
    const now = '2026-08-02T00:00:00.000Z';
    const expiry = '2026-08-03T00:00:00.000Z';
    const bootstrap = passkeyCeremonyId('bootstrap');
    store.saveCeremony(bootstrap, {
      purpose: 'registration',
      challenge: new Uint8Array([1]),
      expectedOrigin: rp.publicOrigin,
      rpId: rp.rpId,
      expiresAt: expiry,
    });
    expect(
      store.completeRegistration({
        ceremony: bootstrap,
        now,
        device: device('one'),
        session: {
          id: authorizationSessionId('session-one'),
          deviceId: authorizedDeviceId('one'),
          expiresAt: expiry,
        },
      }),
    ).toBe('registered');
    expect(
      store.completeRegistration({
        ceremony: bootstrap,
        now,
        device: device('two'),
        session: {
          id: authorizationSessionId('session-two'),
          deviceId: authorizedDeviceId('two'),
          expiresAt: expiry,
        },
      }),
    ).toBe('ceremonyUnavailable');
    const ticket = enrollmentTicketId('ticket');
    store.saveTicket(ticket, { expiresAt: expiry });
    const enrolled = passkeyCeremonyId('enrolled');
    store.saveCeremony(enrolled, {
      purpose: 'registration',
      challenge: new Uint8Array([2]),
      expectedOrigin: rp.publicOrigin,
      rpId: rp.rpId,
      expiresAt: expiry,
      enrollmentTicket: ticket,
    });
    expect(
      store.completeRegistration({
        ceremony: enrolled,
        now,
        device: device('two'),
        session: {
          id: authorizationSessionId('session-two'),
          deviceId: authorizedDeviceId('two'),
          expiresAt: expiry,
        },
      }),
    ).toBe('registered');
    expect(store.ticketAvailable(ticket, now)).toBe(false);
    expect(store.listAuthorizedDevices()).toHaveLength(2);
    store.close();
  });

  it('rejects mismatched registration session targets without consuming the ceremony or inserting a device', async () => {
    const directory = await home();
    const store = new SqliteAuthorizationStore(directory, rp);
    store.initializeOwner(owner().userHandle);
    const ceremony = passkeyCeremonyId('mismatch');
    store.saveCeremony(ceremony, {
      purpose: 'registration',
      challenge: new Uint8Array([1]),
      expectedOrigin: rp.publicOrigin,
      rpId: rp.rpId,
      expiresAt: '2026-08-03T00:00:00.000Z',
    });
    expect(() =>
      store.completeRegistration({
        ceremony,
        now: '2026-08-02T00:00:00.000Z',
        device: device('one'),
        session: {
          id: authorizationSessionId('mismatch-session'),
          deviceId: authorizedDeviceId('other'),
          expiresAt: '2026-08-03T00:00:00.000Z',
        },
      }),
    ).toThrow('AUTHORIZATION_SESSION_DEVICE_MISMATCH');
    expect(store.listAuthorizedDevices()).toHaveLength(0);
    expect(store.readCeremony(ceremony, '2026-08-02T00:00:00.000Z')).not.toBeNull();
    store.close();
  });

  it('preserves one-time artifacts when a ticket is expired or the credential is duplicate', async () => {
    const directory = await home();
    const store = new SqliteAuthorizationStore(directory, rp);
    store.initializeOwner(owner().userHandle);
    const now = '2026-08-02T00:00:00.000Z';
    expect(store.claimFirstDevice(owner(), device('one'))).toBe('claimed');
    const expired = enrollmentTicketId('expired');
    store.saveTicket(expired, { expiresAt: '2026-08-01T00:00:00.000Z' });
    const expiredCeremony = passkeyCeremonyId('expired-ceremony');
    store.saveCeremony(expiredCeremony, {
      purpose: 'registration',
      challenge: new Uint8Array([1]),
      expectedOrigin: rp.publicOrigin,
      rpId: rp.rpId,
      expiresAt: '2026-08-03T00:00:00.000Z',
      enrollmentTicket: expired,
    });
    expect(
      store.completeRegistration({
        ceremony: expiredCeremony,
        now,
        device: device('two'),
        session: {
          id: authorizationSessionId('two'),
          deviceId: authorizedDeviceId('two'),
          expiresAt: '2026-08-03T00:00:00.000Z',
        },
      }),
    ).toBe('ticketUnavailable');
    expect(store.readCeremony(expiredCeremony, now)).not.toBeNull();
    const inspection = new DatabaseSync(authorizationDatabasePath(directory));
    expect(inspection.prepare('SELECT consumed_at FROM auth_tickets').get()).toEqual({
      consumed_at: null,
    });
    inspection.close();
    const ticket = enrollmentTicketId('live');
    store.saveTicket(ticket, { expiresAt: '2026-08-03T00:00:00.000Z' });
    const duplicate = passkeyCeremonyId('duplicate');
    store.saveCeremony(duplicate, {
      purpose: 'registration',
      challenge: new Uint8Array([1]),
      expectedOrigin: rp.publicOrigin,
      rpId: rp.rpId,
      expiresAt: '2026-08-03T00:00:00.000Z',
      enrollmentTicket: ticket,
    });
    expect(
      store.completeRegistration({
        ceremony: duplicate,
        now,
        device: device('duplicate', 'credential-one'),
        session: {
          id: authorizationSessionId('three'),
          deviceId: authorizedDeviceId('duplicate'),
          expiresAt: '2026-08-03T00:00:00.000Z',
        },
      }),
    ).toBe('duplicateCredential');
    expect(store.ticketAvailable(ticket, now)).toBe(true);
    expect(store.readCeremony(duplicate, now)).not.toBeNull();
    store.close();
  });

  it('uses CAS for stale writers and preserves zero-counter multi-device assertions', async () => {
    const directory = await home();
    const first = new SqliteAuthorizationStore(directory, rp);
    const second = new SqliteAuthorizationStore(directory, rp);
    first.initializeOwner(owner().userHandle);
    const synced = device('one', 'credential-one', { deviceType: 'multiDevice', backedUp: true });
    expect(first.claimFirstDevice(owner(), synced)).toBe('claimed');
    expect(first.renameDevice(synced.id, 0, deviceNickname('Renamed'))).toBe('renamed');
    expect(second.renameDevice(synced.id, 0, deviceNickname('Lost update'))).toBe('stale');
    expect(second.advanceCounter(synced.id, 0, 1, 0, '2026-08-02T01:00:00.000Z')).toBe(true);
    expect(first.advanceCounter(synced.id, 0, 1, 0, '2026-08-02T02:00:00.000Z')).toBe(false);
    expect(first.findDevice(synced.id)).toMatchObject({
      counter: 0,
      lastUsedAt: '2026-08-02T01:00:00.000Z',
      version: 2,
    });
    first.close();
    second.close();
  });

  it('atomically completes authentication across stores with hashed absolute sessions and no partial failures', async () => {
    const directory = await home();
    const first = new SqliteAuthorizationStore(directory, rp);
    const second = new SqliteAuthorizationStore(directory, rp);
    const now = '2026-08-02T00:00:00.000Z';
    const expiresAt = '2026-09-01T00:00:00.000Z';
    first.initializeOwner(owner().userHandle);
    const single = device('single', 'credential-single');
    const synced = device('synced', 'credential-synced', {
      deviceType: 'multiDevice',
      backedUp: true,
    });
    first.claimFirstDevice(owner(), single);
    first.authorizeDevice(synced);
    const save = (token: string) =>
      first.saveCeremony(passkeyCeremonyId(token), {
        purpose: 'authentication',
        challenge: new Uint8Array([1]),
        expectedOrigin: rp.publicOrigin,
        rpId: rp.rpId,
        expiresAt: '2026-08-03T00:00:00.000Z',
      });
    save('single-invalid');
    expect(
      first.completeAuthentication({
        ceremony: passkeyCeremonyId('single-invalid'),
        now,
        device: single,
        nextCounter: 0,
        session: { id: authorizationSessionId('session-invalid'), deviceId: single.id, expiresAt },
      }),
    ).toBe(false);
    expect(first.readCeremony(passkeyCeremonyId('single-invalid'), now)).not.toBeNull();
    expect(first.findDevice(single.id)).toMatchObject({ counter: 0, version: 0 });
    save('synced');
    expect(
      first.completeAuthentication({
        ceremony: passkeyCeremonyId('synced'),
        now,
        device: synced,
        nextCounter: 0,
        session: { id: authorizationSessionId('session-raw'), deviceId: synced.id, expiresAt },
      }),
    ).toBe(true);
    expect(
      second.sessionDevice(authorizationSessionId('session-raw'), '2026-08-31T23:59:59.999Z'),
    ).toBe(synced.id);
    expect(second.sessionDevice(authorizationSessionId('session-raw'), expiresAt)).toBeNull();
    expect(first.findDevice(synced.id)).toMatchObject({ counter: 0, lastUsedAt: now, version: 1 });
    const inspection = new DatabaseSync(authorizationDatabasePath(directory));
    expect(inspection.prepare('SELECT expires_at FROM auth_sessions').all()).toContainEqual({
      expires_at: expiresAt,
    });
    inspection.close();
    expect((await readFile(authorizationDatabasePath(directory))).includes('session-raw')).toBe(
      false,
    );
    save('collision');
    first.saveSession(authorizationSessionId('collision-token'), {
      deviceId: single.id,
      expiresAt,
    });
    expect(() =>
      first.completeAuthentication({
        ceremony: passkeyCeremonyId('collision'),
        now,
        device: single,
        nextCounter: 1,
        session: { id: authorizationSessionId('collision-token'), deviceId: single.id, expiresAt },
      }),
    ).toThrow();
    expect(first.readCeremony(passkeyCeremonyId('collision'), now)).not.toBeNull();
    expect(first.findDevice(single.id)).toMatchObject({ counter: 0, version: 0 });
    expect(second.revokeSession(authorizationSessionId('session-raw'), now)).toBe(true);
    expect(
      first.sessionDevice(authorizationSessionId('session-raw'), '2026-08-02T00:00:01.000Z'),
    ).toBeNull();
    first.close();
    second.close();
  });

  it('revokes all sessions durably, removes the device, and preserves exactly one final device under races', async () => {
    const directory = await home();
    const first = new SqliteAuthorizationStore(directory, rp);
    const second = new SqliteAuthorizationStore(directory, rp);
    first.initializeOwner(owner().userHandle);
    const one = device('one');
    const two = device('two');
    expect(first.claimFirstDevice(owner(), one)).toBe('claimed');
    expect(first.authorizeDevice(two)).toBe('authorized');
    first.saveSession(authorizationSessionId('one-a'), {
      deviceId: one.id,
      expiresAt: '2026-09-01T00:00:00.000Z',
    });
    first.saveSession(authorizationSessionId('one-b'), {
      deviceId: one.id,
      expiresAt: '2026-09-01T00:00:00.000Z',
    });
    expect(second.revokeDevice(one.id, '2026-08-02T01:00:00.000Z')).toBe('revoked');
    expect(first.findDevice(one.id)).toBeNull();
    expect(
      first.sessionDevice(authorizationSessionId('one-a'), '2026-08-02T02:00:00.000Z'),
    ).toBeNull();
    expect(
      second.sessionDevice(authorizationSessionId('one-b'), '2026-08-02T02:00:00.000Z'),
    ).toBeNull();
    expect(first.revokeDevice(two.id, '2026-08-02T02:00:00.000Z')).toBe('finalDevice');
    expect(first.listAuthorizedDevices()).toHaveLength(1);
    first.close();
    second.close();
  });

  it('rejects RP hostname changes after credentials and keeps schema initialization idempotent', async () => {
    const directory = await home();
    const store = new SqliteAuthorizationStore(directory, rp);
    store.initializeOwner(owner().userHandle);
    expect(store.claimFirstDevice(owner(), device('one'))).toBe('claimed');
    store.close();
    expect(
      () =>
        new SqliteAuthorizationStore(directory, {
          ...rp,
          publicOrigin: 'https://other.example',
          rpId: 'other.example',
        }),
    ).toThrow('hostname changed');
    const same = new SqliteAuthorizationStore(directory, {
      ...rp,
      publicOrigin: 'https://gestalt.example:9443',
    });
    expect(same.readOwner()).not.toBeNull();
    same.close();
  });

  it('allows exactly one competing revocation from a two-device starting state', async () => {
    const directory = await home();
    const first = new SqliteAuthorizationStore(directory, rp);
    const second = new SqliteAuthorizationStore(directory, rp);
    first.initializeOwner(owner().userHandle);
    const one = device('one');
    const two = device('two');
    first.claimFirstDevice(owner(), one);
    first.authorizeDevice(two);
    expect(first.revokeDevice(one.id, '2026-08-02T01:00:00.000Z')).toBe('revoked');
    expect(second.revokeDevice(two.id, '2026-08-02T01:00:00.000Z')).toBe('finalDevice');
    expect(second.listAuthorizedDevices()).toHaveLength(1);
    first.close();
    second.close();
  });

  it('allows exactly one of two independently opened bootstrap ceremonies to establish authorization', async () => {
    const directory = await home();
    const first = new SqliteAuthorizationStore(directory, rp);
    const second = new SqliteAuthorizationStore(directory, rp);
    first.initializeOwner(owner().userHandle);
    const now = '2026-08-02T00:00:00.000Z';
    const expiry = '2026-08-03T00:00:00.000Z';
    const winner = passkeyCeremonyId('bootstrap-winner');
    const loser = passkeyCeremonyId('bootstrap-loser');
    first.saveCeremony(winner, {
      purpose: 'registration',
      challenge: new Uint8Array([1]),
      expectedOrigin: rp.publicOrigin,
      rpId: rp.rpId,
      expiresAt: expiry,
    });
    second.saveCeremony(loser, {
      purpose: 'registration',
      challenge: new Uint8Array([2]),
      expectedOrigin: rp.publicOrigin,
      rpId: rp.rpId,
      expiresAt: expiry,
    });
    expect(
      first.completeRegistration({
        ceremony: winner,
        now,
        device: device('one'),
        session: {
          id: authorizationSessionId('winner-session'),
          deviceId: authorizedDeviceId('one'),
          expiresAt: expiry,
        },
      }),
    ).toBe('registered');
    expect(
      second.completeRegistration({
        ceremony: loser,
        now,
        device: device('two'),
        session: {
          id: authorizationSessionId('loser-session'),
          deviceId: authorizedDeviceId('two'),
          expiresAt: expiry,
        },
      }),
    ).toBe('bootstrapAlreadyClaimed');
    expect(second.readCeremony(loser, now)).not.toBeNull();
    expect(
      second.completeRegistration({
        ceremony: loser,
        now,
        device: device('three'),
        session: {
          id: authorizationSessionId('later-session'),
          deviceId: authorizedDeviceId('three'),
          expiresAt: expiry,
        },
      }),
    ).toBe('bootstrapAlreadyClaimed');
    expect(first.listAuthorizedDevices()).toHaveLength(1);
    first.close();
    second.close();
  });

  it('consumes a live enrollment ticket once across competing ceremonies while preserving unavailable artifacts', async () => {
    const directory = await home();
    const first = new SqliteAuthorizationStore(directory, rp);
    const second = new SqliteAuthorizationStore(directory, rp);
    first.initializeOwner(owner().userHandle);
    first.claimFirstDevice(owner(), device('one'));
    const now = '2026-08-02T00:00:00.000Z';
    const expiry = '2026-08-03T00:00:00.000Z';
    const ticket = enrollmentTicketId('shared-live-ticket');
    const creator = authorizationSessionId('ticket-creator-session');
    first.saveSession(creator, { deviceId: authorizedDeviceId('one'), expiresAt: expiry });
    first.issueEnrollmentTicket(ticket, creator, expiry);
    const firstCeremony = passkeyCeremonyId('ticket-first');
    const secondCeremony = passkeyCeremonyId('ticket-second');
    for (const ceremony of [firstCeremony, secondCeremony])
      first.saveCeremony(ceremony, {
        purpose: 'registration',
        challenge: new Uint8Array([3]),
        expectedOrigin: rp.publicOrigin,
        rpId: rp.rpId,
        expiresAt: expiry,
        enrollmentTicket: ticket,
      });
    expect(
      first.completeRegistration({
        ceremony: firstCeremony,
        now,
        device: device('two'),
        session: {
          id: authorizationSessionId('ticket-one'),
          deviceId: authorizedDeviceId('two'),
          expiresAt: expiry,
        },
      }),
    ).toBe('registered');
    expect(
      second.completeRegistration({
        ceremony: secondCeremony,
        now,
        device: device('three'),
        session: {
          id: authorizationSessionId('ticket-two'),
          deviceId: authorizedDeviceId('three'),
          expiresAt: expiry,
        },
      }),
    ).toBe('ticketUnavailable');
    expect(second.readCeremony(secondCeremony, now)).not.toBeNull();
    expect(first.listAuthorizedDevices().map((device) => device.id)).toEqual([
      authorizedDeviceId('one'),
      authorizedDeviceId('two'),
    ]);
    expect(second.sessionDevice(authorizationSessionId('ticket-one'), now)).toBe(authorizedDeviceId('two'));
    expect(second.sessionDevice(authorizationSessionId('ticket-two'), now)).toBeNull();
    first.close();
    second.close();
  });

  it('replaces a creator session ticket and fails closed when that session is revoked before atomic registration', async () => {
    const directory = await home();
    const store = new SqliteAuthorizationStore(directory, rp);
    store.initializeOwner(owner().userHandle);
    store.claimFirstDevice(owner(), device('one'));
    const now = '2026-08-02T00:00:00.000Z';
    const expiry = '2026-08-02T00:10:00.000Z';
    const creator = authorizationSessionId('creator-session-secret');
    store.saveSession(creator, { deviceId: authorizedDeviceId('one'), expiresAt: expiry });
    const replaced = enrollmentTicketId('replaced-ticket-secret');
    const live = enrollmentTicketId('live-ticket-secret');
    store.issueEnrollmentTicket(replaced, creator, expiry);
    store.issueEnrollmentTicket(live, creator, expiry);
    expect(store.ticketAvailable(replaced, now)).toBe(false);
    expect(store.ticketAvailable(live, now)).toBe(true);
    const ceremony = passkeyCeremonyId('creator-revoked-ceremony');
    store.saveCeremony(ceremony, { purpose: 'registration', challenge: new Uint8Array([3]), expectedOrigin: rp.publicOrigin, rpId: rp.rpId, expiresAt: expiry, enrollmentTicket: live });
    expect(store.revokeSession(creator, now)).toBe(true);
    expect(store.completeRegistration({ ceremony, now, device: device('two'), session: { id: authorizationSessionId('enrolled-session-secret'), deviceId: authorizedDeviceId('two'), expiresAt: expiry } })).toBe('ticketUnavailable');
    expect(store.listAuthorizedDevices()).toHaveLength(1);
    store.close();
    const database = await readFile(authorizationDatabasePath(directory));
    expect(database.includes('live-ticket-secret')).toBe(false);
    expect(database.includes('creator-session-secret')).toBe(false);
  });

  it('shares pending, expired, used, and cancelled creator-ticket status across stores', async () => {
    const directory = await home();
    const first = new SqliteAuthorizationStore(directory, rp);
    const second = new SqliteAuthorizationStore(directory, rp);
    first.initializeOwner(owner().userHandle);
    first.claimFirstDevice(owner(), device('one'));
    const creator = authorizationSessionId('status-creator-secret');
    const now = '2026-08-02T00:00:00.000Z';
    first.saveSession(creator, { deviceId: authorizedDeviceId('one'), expiresAt: '2026-08-03T00:00:00.000Z' });
    first.issueEnrollmentTicket(enrollmentTicketId('status-pending-secret'), creator, '2026-08-02T00:10:00.000Z');
    expect(second.enrollmentTicketStatus(creator, now)).toBe('pending');
    expect(second.cancelEnrollmentTicket(creator, now)).toBe(true);
    expect(first.enrollmentTicketStatus(creator, now)).toBe('none');
    first.issueEnrollmentTicket(enrollmentTicketId('status-expired-secret'), creator, '2026-08-01T00:00:00.000Z');
    expect(second.enrollmentTicketStatus(creator, now)).toBe('expired');
    first.issueEnrollmentTicket(enrollmentTicketId('status-used-secret'), creator, '2026-08-03T00:00:00.000Z');
    const ceremony = passkeyCeremonyId('status-used-ceremony');
    first.saveCeremony(ceremony, { purpose: 'registration', challenge: new Uint8Array([1]), expectedOrigin: rp.publicOrigin, rpId: rp.rpId, expiresAt: '2026-08-03T00:00:00.000Z', enrollmentTicket: enrollmentTicketId('status-used-secret') });
    expect(first.completeRegistration({ ceremony, now, device: device('two'), session: { id: authorizationSessionId('status-enrolled-secret'), deviceId: authorizedDeviceId('two'), expiresAt: '2026-08-03T00:00:00.000Z' } })).toBe('registered');
    expect(second.enrollmentTicketStatus(creator, now)).toBe('used');
    first.close(); second.close();
  });

  it('refuses an empty injected owner handle', async () => {
    const store = new SqliteAuthorizationStore(await home(), rp);
    expect(() => store.initializeOwner(new Uint8Array())).toThrow('must not be empty');
    store.close();
  });

  it('atomically consumes authentication ceremonies, advances counters, and shares revocation across stores', async () => {
    const directory = await home();
    const first = new SqliteAuthorizationStore(directory, rp);
    const second = new SqliteAuthorizationStore(directory, rp);
    first.initializeOwner(owner().userHandle);
    const credential = device('one', 'credential-one');
    first.claimFirstDevice(owner(), credential);
    const now = '2026-08-02T00:00:00.000Z';
    const expiresAt = '2026-09-01T00:00:00.000Z';
    const ceremony = passkeyCeremonyId('auth-ceremony');
    first.saveCeremony(ceremony, {
      purpose: 'authentication',
      challenge: new Uint8Array([1]),
      expectedOrigin: rp.publicOrigin,
      rpId: rp.rpId,
      expiresAt,
    });
    expect(
      first.completeAuthentication({
        ceremony,
        now,
        device: credential,
        nextCounter: 1,
        session: {
          id: authorizationSessionId('shared-session'),
          deviceId: credential.id,
          expiresAt,
        },
      }),
    ).toBe(true);
    expect(second.sessionDevice(authorizationSessionId('shared-session'), now)).toBe(credential.id);
    expect(second.findDevice(credential.id)).toMatchObject({ counter: 1, lastUsedAt: now });
    expect(
      second.completeAuthentication({
        ceremony,
        now,
        device: credential,
        nextCounter: 2,
        session: {
          id: authorizationSessionId('replay-session'),
          deviceId: credential.id,
          expiresAt,
        },
      }),
    ).toBe(false);
    expect(second.revokeSession(authorizationSessionId('shared-session'), now)).toBe(true);
    expect(first.sessionDevice(authorizationSessionId('shared-session'), now)).toBeNull();
    first.close();
    second.close();
  });
});
