/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import type { AuthorizationRepository, WebAuthnCeremonyService } from '../application/ports.js';
import type { AuthorizedDevice } from '../domain/authorization.js';
import { deviceNickname } from '../domain/device-nickname.js';
import {
  authorizationSessionId,
  authorizedDeviceId,
  localOwnerId,
  webAuthnCredentialId,
} from '../domain/identifiers.js';
import { SqliteAuthorizationStore } from '../../../platform/auth/sqlite-authorization-store.js';

const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const rp = { publicOrigin: 'https://gestalt.example', rpId: 'gestalt.example', rpName: 'Gestalt Mobile' as const };
const clock = { now: () => new Date('2026-08-02T00:00:00.000Z') };
const first: AuthorizedDevice = {
  id: authorizedDeviceId('device-one'), credentialId: webAuthnCredentialId('credential-secret-one'),
  publicKey: new Uint8Array([9, 8, 7]), counter: 42, transports: ['internal'],
  deviceType: 'singleDevice', backedUp: false, nickname: deviceNickname('Phone'),
  createdAt: '2026-08-01T00:00:00.000Z', version: 3,
};
const second: AuthorizedDevice = {
  ...first, id: authorizedDeviceId('device-two'), credentialId: webAuthnCredentialId('credential-secret-two'),
  nickname: deviceNickname('Tablet'), createdAt: '2026-08-02T00:00:00.000Z',
  lastUsedAt: '2026-08-02T01:00:00.000Z', version: 0,
};

function repository(overrides: Partial<AuthorizationRepository> = {}): AuthorizationRepository {
  return {
    initializeOwner: (userHandle) => ({ id: localOwnerId('owner'), userHandle }), readOwner: () => null,
    listAuthorizedDevices: () => [first, second], claimFirstDevice: () => 'claimed', authorizeDevice: () => 'authorized',
    findDeviceByCredentialId: () => null, findDevice: (id) => [first, second].find((device) => device.id === id) ?? null,
    renameDevice: () => 'renamed', advanceCounter: () => false, revokeDevice: () => 'revoked',
    saveCeremony: () => {}, consumeCeremony: () => null, readCeremony: () => null, saveTicket: () => {},
    issueEnrollmentTicket: () => {},
    enrollmentTicketStatus: () => 'none', cancelEnrollmentTicket: () => false,
    consumeTicket: () => false, ticketAvailable: () => false, completeRegistration: () => 'ceremonyUnavailable',
    completeAuthentication: () => false, saveSession: () => {},
    sessionDevice: (token) => token === authorizationSessionId('live') ? first.id : null,
    revokeSession: () => false, close: () => {}, ...overrides,
  };
}

const webauthn: WebAuthnCeremonyService = {
  registrationOptions: async () => ({}), authenticationOptions: async () => ({}),
  verifyRegistration: async () => { throw new Error('unused'); },
  verifyAuthentication: async () => { throw new Error('unused'); },
};

async function app(repo = repository()) {
  return buildApp({
    health: { read: async () => ({ status: 'ok', version: 'test', codex: { installedVersion: null, protocolVersion: 'test', compatible: true } }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    auth: { repository: repo, clock, random: { bytes: (length) => new Uint8Array(length) }, identifiers: { deviceId: () => first.id, sessionId: () => authorizationSessionId('session') }, webauthn, relyingParty: rp },
  });
}

const authenticated = { cookie: 'gestalt_mobile_session=live', origin: rp.publicOrigin };

describe('device-management endpoints', () => {
  it('returns ordered safe metadata without absent dates or credential material', async () => {
    const instance = await app();
    const response = await instance.inject({ method: 'GET', url: '/api/auth/devices', headers: authenticated });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ devices: [
      { id: 'device-one', nickname: 'Phone', createdAt: first.createdAt, current: true },
      { id: 'device-two', nickname: 'Tablet', createdAt: second.createdAt, lastUsedAt: second.lastUsedAt, current: false },
    ] });
    for (const forbidden of ['credential-secret-one', 'credential-secret-two', '9,8,7', '42', 'internal'])
      expect(response.body).not.toContain(forbidden);
    await instance.close();
  });

  it('validates Unicode nickname code points and maps unknown devices to stable problems', async () => {
    const renamed: { id?: string; nickname?: string } = {};
    const instance = await app(repository({
      renameDevice: (id, _version, nickname) => { renamed.id = id; renamed.nickname = nickname; return 'renamed'; },
      revokeDevice: (id) => id === authorizedDeviceId('unknown-credential-material') ? 'notFound' : 'revoked',
    }));
    const valid = await instance.inject({ method: 'PATCH', url: '/api/auth/devices/device-two', headers: authenticated, payload: { nickname: `  ${'🧭'.repeat(64)}  ` } });
    expect(valid.statusCode).toBe(204);
    expect(renamed).toEqual({ id: 'device-two', nickname: '🧭'.repeat(64) });
    const invalid = await instance.inject({ method: 'PATCH', url: '/api/auth/devices/device-two', headers: authenticated, payload: { nickname: '🧭'.repeat(65) } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('INVALID_DEVICE_REQUEST');
    const unknown = await instance.inject({ method: 'PATCH', url: '/api/auth/devices/unknown', headers: authenticated, payload: { nickname: 'New name' } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'DEVICE_NOT_AVAILABLE', detail: 'The requested device is not available.' });
    expect(unknown.body).not.toContain('unknown');
    const unknownDelete = await instance.inject({ method: 'DELETE', url: '/api/auth/devices/unknown-credential-material', headers: authenticated });
    expect(unknownDelete.statusCode).toBe(404);
    expect(unknownDelete.json()).toMatchObject({ code: 'DEVICE_NOT_AVAILABLE', detail: 'The requested device is not available.' });
    expect(unknownDelete.body).not.toContain('unknown-credential-material');
    await instance.close();
  });

  it('rejects malformed device IDs and trimmed-empty nicknames at the endpoint boundary', async () => {
    const instance = await app();
    for (const method of ['PATCH', 'DELETE'] as const) {
      const response = await instance.inject({ method, url: '/api/auth/devices/%20', headers: authenticated, ...(method === 'PATCH' ? { payload: { nickname: 'Name' } } : {}) });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('INVALID_DEVICE_REQUEST');
    }
    const empty = await instance.inject({ method: 'PATCH', url: '/api/auth/devices/device-one', headers: authenticated, payload: { nickname: ' \u00a0 ' } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().code).toBe('INVALID_DEVICE_REQUEST');
    await instance.close();
  });

  it('requires authentication and exact origin, clears the current cookie, and protects the final device', async () => {
    const instance = await app(repository({ revokeDevice: () => 'revoked' }));
    expect((await instance.inject({ method: 'GET', url: '/api/auth/devices' })).statusCode).toBe(401);
    expect((await instance.inject({ method: 'DELETE', url: '/api/auth/devices/device-one', headers: { cookie: authenticated.cookie, origin: 'https://attacker.example' } })).statusCode).toBe(403);
    const removed = await instance.inject({ method: 'DELETE', url: '/api/auth/devices/device-one', headers: authenticated });
    expect(removed.statusCode).toBe(204);
    expect(removed.headers['set-cookie']).toContain('gestalt_mobile_session=;');
    await instance.close();

    const final = await app(repository({ revokeDevice: () => 'finalDevice' }));
    const refusal = await final.inject({ method: 'DELETE', url: '/api/auth/devices/device-one', headers: authenticated });
    expect(refusal.statusCode).toBe(409);
    expect(refusal.json().code).toBe('LAST_DEVICE_REQUIRED');
    await final.close();
  });

  it('shares endpoint mutations across SQLite instances, invalidates every linked session, and redacts responses and logs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-device-endpoints-'));
    paths.push(directory);
    const storeOne = new SqliteAuthorizationStore(directory, rp);
    const storeTwo = new SqliteAuthorizationStore(directory, rp);
    storeOne.initializeOwner(new Uint8Array([1]));
    storeOne.claimFirstDevice({ id: localOwnerId('local-owner'), userHandle: new Uint8Array([1]) }, first);
    storeOne.authorizeDevice(second);
    const expiresAt = '2026-09-01T00:00:00.000Z';
    for (const token of ['live-one-raw-token', 'linked-one-raw-token'])
      storeOne.saveSession(authorizationSessionId(token), { deviceId: first.id, expiresAt });
    storeTwo.saveSession(authorizationSessionId('live-two-raw-token'), { deviceId: second.id, expiresAt });
    const logs: string[] = [];
    const logger = { info: (...values: unknown[]) => logs.push(values.join(' ')), warn: (...values: unknown[]) => logs.push(values.join(' ')), error: (...values: unknown[]) => logs.push(values.join(' ')) };
    const instanceOne = await buildApp({ health: { read: async () => ({ status: 'ok', version: 'test', codex: { installedVersion: null, protocolVersion: 'test', compatible: true } }) }, logger, auth: { repository: storeOne, clock, random: { bytes: (length) => new Uint8Array(length) }, identifiers: { deviceId: () => first.id, sessionId: () => authorizationSessionId('unused') }, webauthn, relyingParty: rp } });
    const instanceTwo = await buildApp({ health: { read: async () => ({ status: 'ok', version: 'test', codex: { installedVersion: null, protocolVersion: 'test', compatible: true } }) }, logger, auth: { repository: storeTwo, clock, random: { bytes: (length) => new Uint8Array(length) }, identifiers: { deviceId: () => second.id, sessionId: () => authorizationSessionId('unused') }, webauthn, relyingParty: rp } });
    const oneHeaders = { cookie: 'gestalt_mobile_session=live-one-raw-token', origin: rp.publicOrigin };
    const twoHeaders = { cookie: 'gestalt_mobile_session=live-two-raw-token', origin: rp.publicOrigin };
    const renamed = await instanceOne.inject({ method: 'PATCH', url: '/api/auth/devices/device-one', headers: oneHeaders, payload: { nickname: 'Renamed phone' } });
    expect(renamed.statusCode).toBe(204);
    const visible = await instanceTwo.inject({ method: 'GET', url: '/api/auth/devices', headers: twoHeaders });
    expect(visible.json()).toEqual({ devices: [
      { id: 'device-one', nickname: 'Renamed phone', createdAt: first.createdAt, current: false },
      { id: 'device-two', nickname: 'Tablet', createdAt: second.createdAt, lastUsedAt: second.lastUsedAt, current: true },
    ] });
    const revoked = await instanceOne.inject({ method: 'DELETE', url: '/api/auth/devices/device-one', headers: oneHeaders });
    expect(revoked.statusCode).toBe(204);
    expect(revoked.headers['set-cookie']).toContain('gestalt_mobile_session=;');
    expect(storeTwo.sessionDevice(authorizationSessionId('live-one-raw-token'), clock.now().toISOString())).toBeNull();
    expect(storeTwo.sessionDevice(authorizationSessionId('linked-one-raw-token'), clock.now().toISOString())).toBeNull();
    expect((await instanceTwo.inject({ method: 'GET', url: '/api/auth/devices', headers: { cookie: 'gestalt_mobile_session=linked-one-raw-token' } })).statusCode).toBe(401);
    expect((await instanceTwo.inject({ method: 'GET', url: '/api/auth/devices', headers: twoHeaders })).json()).toEqual({ devices: [
      { id: 'device-two', nickname: 'Tablet', createdAt: second.createdAt, lastUsedAt: second.lastUsedAt, current: true },
    ] });
    for (const token of ['%', 'expired-raw-token', 'revoked-raw-token']) {
      if (token === 'expired-raw-token') storeTwo.saveSession(authorizationSessionId(token), { deviceId: second.id, expiresAt: '2026-08-01T00:00:00.000Z' });
      if (token === 'revoked-raw-token') {
        storeTwo.saveSession(authorizationSessionId(token), { deviceId: second.id, expiresAt });
        storeTwo.revokeSession(authorizationSessionId(token), clock.now().toISOString());
      }
      expect((await instanceTwo.inject({ method: 'GET', url: '/api/auth/devices', headers: { cookie: `gestalt_mobile_session=${token}` } })).statusCode).toBe(401);
    }
    for (const forbidden of ['credential-secret-one', 'credential-secret-two', '9,8,7', '42', 'live-one-raw-token', 'linked-one-raw-token', 'ceremony-material-raw']) {
      expect(visible.body).not.toContain(forbidden);
      expect(JSON.stringify(logs)).not.toContain(forbidden);
    }
    await instanceOne.close(); await instanceTwo.close(); storeOne.close(); storeTwo.close();
  });
});
