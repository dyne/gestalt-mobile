/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../app.js';
import type { WebAuthnCeremonyService } from '../application/ports.js';
import {
  authorizationSessionId,
  authorizedDeviceId,
  localOwnerId,
  webAuthnCredentialId,
} from '../domain/identifiers.js';
import { deviceNickname } from '../domain/device-nickname.js';
import {
  authorizationDatabasePath,
  SqliteAuthorizationStore,
} from '../../../platform/auth/sqlite-authorization-store.js';

const paths: string[] = [];
const rp = {
  publicOrigin: 'https://gestalt.example:8443',
  rpId: 'gestalt.example',
  rpName: 'Gestalt Mobile' as const,
};
const proof = {
  id: 'new-credential',
  rawId: 'new-credential',
  type: 'public-key' as const,
  response: { clientDataJSON: 'client-data', attestationObject: 'attestation' },
  clientExtensionResults: {},
};

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function token(byte: number) {
  return Buffer.from(new Uint8Array(32).fill(byte)).toString('base64url');
}

function capturedLogger() {
  const messages: string[] = [];
  return {
    messages,
    logger: {
      info: (...values: unknown[]) => messages.push(JSON.stringify(values)),
      warn: (...values: unknown[]) => messages.push(JSON.stringify(values)),
      error: (...values: unknown[]) => messages.push(JSON.stringify(values)),
    },
  };
}

function webauthn(calls: Array<{ expectedOrigin: string; rpId: string }>): WebAuthnCeremonyService {
  return {
    registrationOptions: async (input) => ({
      challenge: Buffer.from(input.challenge).toString('base64url'),
      rp: { id: input.rpId, name: input.rpName },
    }),
    authenticationOptions: async () => ({}),
    verifyRegistration: async (input) => {
      calls.push({ expectedOrigin: input.expectedOrigin, rpId: input.rpId });
      return {
        credentialId: webAuthnCredentialId('new-credential'),
        publicKey: new Uint8Array([9, 8, 7]),
        counter: 0,
        userVerified: true,
        transports: ['internal'],
        deviceType: 'singleDevice',
        backedUp: false,
      };
    },
    verifyAuthentication: async () => {
      throw new Error('not used');
    },
  };
}

async function home() {
  const value = await mkdtemp(join(tmpdir(), 'gestalt-enrollment-http-'));
  paths.push(value);
  return value;
}

async function appFor(
  repository: SqliteAuthorizationStore,
  now: { value: Date },
  entropy: number[],
  identifiers: { device: string; session: string },
  calls: Array<{ expectedOrigin: string; rpId: string }>,
  logger = capturedLogger(),
) {
  let next = 0;
  const app = await buildApp({
    health: {
      read: async () => ({
        status: 'ok',
        version: 'test',
        codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
      }),
    },
    logger: logger.logger,
    auth: {
      repository,
      clock: { now: () => now.value },
      random: { bytes: (length) => new Uint8Array(length).fill(entropy[next++] ?? 0) },
      identifiers: {
        deviceId: () => authorizedDeviceId(identifiers.device),
        sessionId: () => authorizationSessionId(identifiers.session),
      },
      webauthn: webauthn(calls),
      relyingParty: rp,
    },
  });
  return { app, logs: logger.messages };
}

function cookie(
  response: { headers: { ['set-cookie']?: string | string[] | number | undefined } },
  name: string,
) {
  const values = response.headers['set-cookie'];
  const value = Array.isArray(values) ? values : [values];
  const found = value.find(
    (item): item is string => typeof item === 'string' && item.startsWith(`${name}=`),
  );
  if (!found) throw new Error(`missing ${name} cookie`);
  return found.split(';', 1)[0];
}

describe('cross-instance enrollment ticket HTTP integration', () => {
  it('authorizes exactly one remote registration without disclosing the raw ticket', async () => {
    const directory = await home();
    const now = { value: new Date('2026-08-02T00:00:00.000Z') };
    const storeA = new SqliteAuthorizationStore(directory, rp);
    const storeB = new SqliteAuthorizationStore(directory, rp);
    const owner = { id: localOwnerId('local-owner'), userHandle: new Uint8Array(32).fill(1) };
    const creator = token(20);
    storeA.initializeOwner(owner.userHandle);
    storeA.claimFirstDevice(owner, {
      id: authorizedDeviceId('owner-device'),
      credentialId: webAuthnCredentialId('owner-credential'),
      publicKey: new Uint8Array([1]),
      counter: 0,
      transports: ['internal'],
      deviceType: 'singleDevice',
      backedUp: false,
      nickname: deviceNickname('Owner'),
      createdAt: now.value.toISOString(),
      version: 0,
    });
    storeA.saveSession(authorizationSessionId(creator), {
      deviceId: authorizedDeviceId('owner-device'),
      expiresAt: '2026-09-01T00:00:00.000Z',
    });
    const callsA: Array<{ expectedOrigin: string; rpId: string }> = [];
    const callsB: Array<{ expectedOrigin: string; rpId: string }> = [];
    const loggerA = capturedLogger();
    const loggerB = capturedLogger();
    const { app: appA } = await appFor(
      storeA,
      now,
      [11],
      { device: 'unused-a', session: token(30) },
      callsA,
      loggerA,
    );
    const { app: appB } = await appFor(
      storeB,
      now,
      [12, 13],
      { device: 'remote-device', session: token(14) },
      callsB,
      loggerB,
    );
    const creatorCookie = `gestalt_mobile_session=${creator}`;
    const creationUrl = '/api/auth/enrollment-tickets';
    const created = await appA.inject({
      method: 'POST',
      url: creationUrl,
      headers: { origin: rp.publicOrigin, cookie: creatorCookie },
    });
    expect(created.statusCode).toBe(201);
    const ticket = (created.json() as { ticket: string }).ticket;
    expect(ticket).toBe(token(11));
    const database = await readFile(authorizationDatabasePath(directory));
    expect(database.includes(ticket)).toBe(false);
    expect(database.includes(creator)).toBe(false);
    const optionsRequest = { enrollmentTicket: ticket };
    const options = await appB.inject({
      method: 'POST',
      url: '/api/auth/register/options',
      headers: { origin: rp.publicOrigin },
      payload: optionsRequest,
    });
    expect(options.statusCode).toBe(200);
    const registrationCookie = cookie(options, 'gestalt_mobile_registration');
    const verifyRequest = { response: proof, nickname: 'Remote passkey' };
    const verified = await appB.inject({
      method: 'POST',
      url: '/api/auth/register/verify',
      headers: { origin: rp.publicOrigin, cookie: registrationCookie },
      payload: verifyRequest,
    });
    expect(verified.statusCode).toBe(201);
    const newSession = cookie(verified, 'gestalt_mobile_session');
    expect(storeA.findDevice(authorizedDeviceId('remote-device'))?.nickname).toBe('Remote passkey');
    expect(
      storeA.sessionDevice(
        authorizationSessionId(newSession.split('=', 2)[1]),
        now.value.toISOString(),
      ),
    ).toBe(authorizedDeviceId('remote-device'));
    const visibleOnA = await appA.inject({
      method: 'GET',
      url: '/api/auth/devices',
      headers: { cookie: newSession },
    });
    expect(visibleOnA.statusCode).toBe(200);
    expect(visibleOnA.json().devices).toContainEqual(
      expect.objectContaining({ id: 'remote-device', nickname: 'Remote passkey' }),
    );
    const statusUrl = '/api/auth/enrollment-tickets/current';
    const usedStatus = await appA.inject({
      method: 'GET',
      url: statusUrl,
      headers: { cookie: creatorCookie },
    });
    expect(usedStatus.json()).toEqual({ status: 'used' });
    const cancelled = await appA.inject({
      method: 'DELETE',
      url: statusUrl,
      headers: { origin: rp.publicOrigin, cookie: creatorCookie },
    });
    expect(cancelled.json()).toEqual({ status: 'used' });
    expect(
      (
        await appB.inject({ method: 'GET', url: statusUrl, headers: { cookie: creatorCookie } })
      ).json(),
    ).toEqual({ status: 'used' });
    const replay = await appB.inject({
      method: 'POST',
      url: '/api/auth/register/options',
      headers: { origin: rp.publicOrigin },
      payload: optionsRequest,
    });
    expect(replay.statusCode).toBe(403);
    const wrongOrigin = await appB.inject({
      method: 'POST',
      url: '/api/auth/register/options',
      headers: { origin: 'https://attacker.example' },
      payload: optionsRequest,
    });
    expect(wrongOrigin.statusCode).toBe(403);
    expect(callsB).toEqual([{ expectedOrigin: rp.publicOrigin, rpId: rp.rpId }]);
    const serializedLogs = JSON.stringify([...loggerA.messages, ...loggerB.messages]);
    const disclosed = [created.body, JSON.stringify(optionsRequest)].join('\n');
    const forbidden = [
      authorizationDatabasePath(directory),
      creationUrl,
      statusUrl,
      JSON.stringify(created.headers),
      usedStatus.body,
      JSON.stringify(usedStatus.headers),
      cancelled.body,
      JSON.stringify(cancelled.headers),
      options.body,
      JSON.stringify(options.headers),
      JSON.stringify(verifyRequest),
      verified.body,
      JSON.stringify(verified.headers),
      visibleOnA.body,
      JSON.stringify(visibleOnA.headers),
      replay.body,
      JSON.stringify(replay.headers),
      wrongOrigin.body,
      JSON.stringify([...loggerA.messages, ...loggerB.messages]),
    ].join('\n');
    expect(disclosed.includes(ticket)).toBe(true);
    expect(forbidden.includes(ticket)).toBe(false);
    expect(serializedLogs.includes(ticket)).toBe(false);
    await appA.close();
    await appB.close();
    storeA.close();
    storeB.close();
  });

  it('fails closed when the creator session is revoked or its ticket expires', async () => {
    for (const scenario of ['revoked', 'expired'] as const) {
      const directory = await home();
      const now = { value: new Date('2026-08-02T00:00:00.000Z') };
      const storeA = new SqliteAuthorizationStore(directory, rp);
      const storeB = new SqliteAuthorizationStore(directory, rp);
      const owner = { id: localOwnerId('local-owner'), userHandle: new Uint8Array(32).fill(1) };
      const creator = token(scenario === 'revoked' ? 31 : 32);
      storeA.initializeOwner(owner.userHandle);
      storeA.claimFirstDevice(owner, {
        id: authorizedDeviceId(`owner-${scenario}`),
        credentialId: webAuthnCredentialId(`owner-${scenario}`),
        publicKey: new Uint8Array([1]),
        counter: 0,
        transports: ['internal'],
        deviceType: 'singleDevice',
        backedUp: false,
        nickname: deviceNickname('Owner'),
        createdAt: now.value.toISOString(),
        version: 0,
      });
      storeA.saveSession(authorizationSessionId(creator), {
        deviceId: authorizedDeviceId(`owner-${scenario}`),
        expiresAt: '2026-09-01T00:00:00.000Z',
      });
      const calls: Array<{ expectedOrigin: string; rpId: string }> = [];
      const { app: appA } = await appFor(
        storeA,
        now,
        [33],
        { device: 'unused', session: token(34) },
        calls,
      );
      const { app: appB } = await appFor(
        storeB,
        now,
        [35, 36],
        { device: `remote-${scenario}`, session: token(37) },
        calls,
      );
      const created = await appA.inject({
        method: 'POST',
        url: '/api/auth/enrollment-tickets',
        headers: { origin: rp.publicOrigin, cookie: `gestalt_mobile_session=${creator}` },
      });
      const ticket = (created.json() as { ticket: string }).ticket;
      if (scenario === 'revoked')
        storeA.revokeSession(authorizationSessionId(creator), now.value.toISOString());
      else now.value = new Date('2026-08-02T00:10:00.001Z');
      const options = await appB.inject({
        method: 'POST',
        url: '/api/auth/register/options',
        headers: { origin: rp.publicOrigin },
        payload: { enrollmentTicket: ticket },
      });
      expect(options.statusCode).toBe(403);
      expect(
        (
          await appA.inject({
            method: 'GET',
            url: '/api/auth/enrollment-tickets/current',
            headers: { cookie: `gestalt_mobile_session=${creator}` },
          })
        ).statusCode,
      ).toBe(scenario === 'revoked' ? 401 : 200);
      if (scenario === 'expired') {
        expect(
          (
            await appA.inject({
              method: 'GET',
              url: '/api/auth/enrollment-tickets/current',
              headers: { cookie: `gestalt_mobile_session=${creator}` },
            })
          ).json(),
        ).toEqual({ status: 'expired' });
        const cancelled = await appB.inject({
          method: 'DELETE',
          url: '/api/auth/enrollment-tickets/current',
          headers: { origin: rp.publicOrigin, cookie: `gestalt_mobile_session=${creator}` },
        });
        expect(cancelled.json()).toEqual({ status: 'expired' });
        expect(
          (
            await appA.inject({
              method: 'GET',
              url: '/api/auth/enrollment-tickets/current',
              headers: { cookie: `gestalt_mobile_session=${creator}` },
            })
          ).json(),
        ).toEqual({ status: 'expired' });
      }
      await appA.close();
      await appB.close();
      storeA.close();
      storeB.close();
    }
  });
});
