/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { buildApp as createApp } from '../../../app.js';
import type { AuthorizationRepository, WebAuthnCeremonyService } from '../application/ports.js';
import {
  authorizationSessionId,
  authorizedDeviceId,
  localOwnerId,
  passkeyCeremonyId,
  webAuthnCredentialId,
} from '../domain/identifiers.js';
import { deviceNickname } from '../domain/device-nickname.js';

const rp = {
  publicOrigin: 'https://gestalt.example',
  rpId: 'gestalt.example',
  rpName: 'Gestalt Mobile' as const,
};
const clock = { now: () => new Date('2026-08-02T00:00:00.000Z') };
const random = { bytes: (length: number) => new Uint8Array(length).fill(7) };
const identifiers = {
  deviceId: () => authorizedDeviceId('device'),
  sessionId: () =>
    authorizationSessionId(Buffer.from(new Uint8Array(32).fill(3)).toString('base64url')),
};

function repository(overrides: Partial<AuthorizationRepository> = {}): AuthorizationRepository {
  return {
    initializeOwner: (userHandle) => ({ id: localOwnerId('local-owner'), userHandle }),
    readOwner: () => ({ id: localOwnerId('local-owner'), userHandle: new Uint8Array(32).fill(1) }),
    listAuthorizedDevices: () => [],
    claimFirstDevice: () => 'claimed',
    authorizeDevice: () => 'authorized',
    findDeviceByCredentialId: () => null,
    findDevice: () => null,
    renameDevice: () => 'notFound',
    advanceCounter: () => false,
    revokeDevice: () => 'notFound',
    saveCeremony: () => {},
    consumeCeremony: () => null,
    readCeremony: () => null,
    saveTicket: () => {},
    issueEnrollmentTicket: () => {},
    enrollmentTicketStatus: () => 'none', cancelEnrollmentTicket: () => false,
    consumeTicket: () => false,
    ticketAvailable: () => false,
    completeRegistration: () => 'ceremonyUnavailable',
    completeAuthentication: () => false,
    saveSession: () => {},
    sessionDevice: () => null,
    revokeSession: () => false,
    close: () => {},
    ...overrides,
  };
}
const webauthn: WebAuthnCeremonyService = {
  registrationOptions: async () => ({ challenge: 'server-owned' }),
  authenticationOptions: async () => ({}),
  verifyRegistration: async () => {
    throw new Error('not used');
  },
  verifyAuthentication: async () => {
    throw new Error('not used');
  },
};
const validProof = {
  id: 'id',
  rawId: 'raw',
  type: 'public-key' as const,
  response: { clientDataJSON: 'client', attestationObject: 'attestation' },
  clientExtensionResults: {},
};
const availableCeremony = {
  id: passkeyCeremonyId('correlation'),
  purpose: 'registration' as const,
  challenge: new Uint8Array([1, 2, 3]),
  expectedOrigin: rp.publicOrigin,
  rpId: rp.rpId,
  expiresAt: '2026-08-03T00:00:00.000Z',
};

async function buildApp(deps: Parameters<typeof createApp>[0]) {
  const app = await createApp(deps);
  const inject = app.inject.bind(app) as (options: unknown) => Promise<unknown>;
  const origin = deps.auth?.relyingParty.publicOrigin;
  app.inject = ((options: string | { headers?: Record<string, string>; [key: string]: unknown }) => {
    if (typeof options === 'string') return inject(options);
    return inject({
      ...options,
      headers: { ...(origin ? { origin } : {}), ...options.headers },
    });
  }) as never;
  return app;
}

describe('registration endpoints', () => {
  it('validates the request and issues only a server-held registration correlation cookie', async () => {
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
      auth: { repository: repository(), clock, random, identifiers, webauthn, relyingParty: rp },
    });
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/auth/register/options',
      payload: { unexpected: true },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('INVALID_REGISTRATION_REQUEST');
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register/options',
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ options: { challenge: 'server-owned' } });
    expect(response.headers['set-cookie']).toContain('gestalt_mobile_registration=');
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('SameSite=Strict');
    await app.close();
  });

  it('never accepts a browser-supplied registration policy or a ticket after bootstrap closes', async () => {
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
      auth: {
        repository: repository({
          listAuthorizedDevices: () => [{ id: 'device' as never }] as never,
          ticketAvailable: () => false,
        }),
        clock,
        random,
        identifiers,
        webauthn,
        relyingParty: rp,
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register/options',
      payload: { enrollmentTicket: 'browser-ticket', rpId: 'attacker.example' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_REGISTRATION_REQUEST');
    const denied = await app.inject({
      method: 'POST',
      url: '/api/auth/register/options',
      payload: { enrollmentTicket: 'browser-ticket' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('ENROLLMENT_NOT_AUTHORIZED');
    await app.close();
  });

  it('issues a session cookie only after the repository atomically completes verified registration', async () => {
    let completed = false;
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
      auth: {
        repository: repository({
          readCeremony: () => ({
            id: passkeyCeremonyId('correlation'),
            purpose: 'registration',
            challenge: new Uint8Array([1]),
            expectedOrigin: rp.publicOrigin,
            rpId: rp.rpId,
            expiresAt: '2026-08-03T00:00:00.000Z',
          }),
          completeRegistration: () => {
            if (completed) return 'ceremonyUnavailable';
            completed = true;
            return 'registered';
          },
        }),
        clock,
        random,
        identifiers,
        webauthn: {
          ...webauthn,
          verifyRegistration: async () => ({
            credentialId: webAuthnCredentialId('credential'),
            publicKey: new Uint8Array([1]),
            counter: 0,
            userVerified: true,
            transports: ['internal'],
            deviceType: 'singleDevice',
            backedUp: false,
          }),
        },
        relyingParty: rp,
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register/verify',
      headers: { cookie: 'gestalt_mobile_registration=correlation' },
      payload: {
        response: {
          id: 'id',
          rawId: 'raw',
          type: 'public-key',
          response: { clientDataJSON: 'client', attestationObject: 'attestation' },
          clientExtensionResults: {},
        },
        nickname: 'Device',
      },
    });
    const cookies = Array.isArray(response.headers['set-cookie'])
      ? response.headers['set-cookie'].join(';')
      : response.headers['set-cookie'];
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ status: 'authenticated' });
    expect(completed).toBe(true);
    expect(cookies).toContain('gestalt_mobile_session=');
    expect(cookies).toContain('HttpOnly');
    expect(deviceNickname('Device')).toBe('Device');
    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/register/verify',
      headers: { cookie: 'gestalt_mobile_registration=correlation' },
      payload: { response: validProof, nickname: 'Device' },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.headers['set-cookie']).toBeUndefined();
    await app.close();
  });

  it('rejects malformed proof before the adapter and lets repository failures reach the safe 500 handler', async () => {
    let verified = false;
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
      auth: {
        repository: repository({
          readCeremony: () => ({
            id: passkeyCeremonyId('correlation'),
            purpose: 'registration',
            challenge: new Uint8Array([1]),
            expectedOrigin: rp.publicOrigin,
            rpId: rp.rpId,
            expiresAt: '2026-08-03T00:00:00.000Z',
          }),
          completeRegistration: () => {
            throw new Error('storage outage');
          },
        }),
        clock,
        random,
        identifiers,
        webauthn: {
          ...webauthn,
          verifyRegistration: async () => {
            verified = true;
            return {
              credentialId: webAuthnCredentialId('credential'),
              publicKey: new Uint8Array([1]),
              counter: 0,
              userVerified: true,
              transports: [],
              deviceType: 'singleDevice',
              backedUp: false,
            };
          },
        },
        relyingParty: rp,
      },
    });
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/auth/register/verify',
      headers: { cookie: 'gestalt_mobile_registration=correlation' },
      payload: { response: {}, nickname: 'Device' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(verified).toBe(false);
    expect(malformed.headers['set-cookie']).toBeUndefined();
    const failure = await app.inject({
      method: 'POST',
      url: '/api/auth/register/verify',
      headers: { cookie: 'gestalt_mobile_registration=correlation' },
      payload: {
        response: {
          id: 'id',
          rawId: 'raw',
          type: 'public-key',
          response: { clientDataJSON: 'client', attestationObject: 'attestation' },
          clientExtensionResults: {},
        },
        nickname: 'Device',
      },
    });
    expect(failure.statusCode).toBe(500);
    expect(failure.json().code).toBe('INTERNAL_ERROR');
    expect(failure.headers['set-cookie']).toBeUndefined();
    await app.close();
  });

  it('does not persist a ceremony or emit a cookie when option generation fails', async () => {
    let saved = false;
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
      auth: {
        repository: repository({
          saveCeremony: () => {
            saved = true;
          },
        }),
        clock,
        random,
        identifiers,
        webauthn: {
          ...webauthn,
          registrationOptions: async () => {
            throw new Error('adapter unavailable');
          },
        },
        relyingParty: rp,
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register/options',
      payload: {},
    });
    expect(response.statusCode).toBe(500);
    expect(saved).toBe(false);
    expect(response.headers['set-cookie']).toBeUndefined();
    await app.close();
  });

  it('passes only the stored ceremony challenge, origin, and RP ID to verification', async () => {
    let verificationInput: unknown;
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
      auth: {
        repository: repository({
          readCeremony: () => availableCeremony,
          completeRegistration: () => 'registered',
        }),
        clock,
        random,
        identifiers,
        webauthn: {
          ...webauthn,
          verifyRegistration: async (input) => {
            verificationInput = input;
            return {
              credentialId: webAuthnCredentialId('credential'),
              publicKey: new Uint8Array([1]),
              counter: 0,
              userVerified: true,
              transports: [],
              deviceType: 'singleDevice',
              backedUp: false,
            };
          },
        },
        relyingParty: rp,
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register/verify',
      headers: { cookie: 'gestalt_mobile_registration=correlation' },
      payload: { response: validProof, nickname: 'Device' },
    });
    expect(response.statusCode).toBe(201);
    expect(verificationInput).toMatchObject({
      challenge: availableCeremony.challenge,
      expectedOrigin: rp.publicOrigin,
      rpId: rp.rpId,
    });
    await app.close();
  });

  it('leaves artifacts and sessions untouched for unavailable ceremonies, invalid nicknames, and failed verification', async () => {
    let reads = 0;
    let completed = 0;
    let verified = 0;
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
      auth: {
        repository: repository({
          readCeremony: () => {
            reads++;
            return availableCeremony;
          },
          completeRegistration: () => {
            completed++;
            return 'registered';
          },
        }),
        clock,
        random,
        identifiers,
        webauthn: {
          ...webauthn,
          verifyRegistration: async () => {
            verified++;
            throw new (await import('../application/ports.js')).PasskeyVerificationError('failed');
          },
        },
        relyingParty: rp,
      },
    });
    const badNickname = await app.inject({
      method: 'POST',
      url: '/api/auth/register/verify',
      headers: { cookie: 'gestalt_mobile_registration=correlation' },
      payload: { response: validProof, nickname: ' ' },
    });
    const failedVerification = await app.inject({
      method: 'POST',
      url: '/api/auth/register/verify',
      headers: { cookie: 'gestalt_mobile_registration=correlation' },
      payload: { response: validProof, nickname: 'Device' },
    });
    expect(badNickname.json().code).toBe('INVALID_DEVICE_NICKNAME');
    expect(reads).toBe(1);
    expect(verified).toBe(1);
    expect(completed).toBe(0);
    expect(badNickname.headers['set-cookie']).toBeUndefined();
    expect(failedVerification.headers['set-cookie']).toBeUndefined();
    await app.close();
  });

  it('rejects an expired, wrong-purpose, replayed, or user-unverified verification without a session cookie', async () => {
    let completion = 0;
    const unverified = {
      credentialId: webAuthnCredentialId('credential'),
      publicKey: new Uint8Array([1]),
      counter: 0,
      userVerified: false,
      transports: [],
      deviceType: 'singleDevice' as const,
      backedUp: false,
    };
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
      auth: {
        repository: repository({
          readCeremony: (token) =>
            token === passkeyCeremonyId('wrong-purpose')
              ? { ...availableCeremony, purpose: 'authentication' }
              : token === passkeyCeremonyId('replay')
                ? null
                : null,
          completeRegistration: () => {
            completion++;
            return 'registered';
          },
        }),
        clock,
        random,
        identifiers,
        webauthn: { ...webauthn, verifyRegistration: async () => unverified },
        relyingParty: rp,
      },
    });
    for (const token of ['expired', 'wrong-purpose', 'replay', 'correlation']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register/verify',
        headers: { cookie: `gestalt_mobile_registration=${token}` },
        payload: { response: validProof, nickname: 'Device' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(completion).toBe(0);
    await app.close();
  });

  it('sets the complete session-cookie contract for HTTPS and omits Secure for localhost HTTP', async () => {
    const successful = (relyingParty = rp) =>
      buildApp({
        health: {
          read: async () => ({
            status: 'ok',
            version: 'test',
            codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
          }),
        },
        logger: console,
        auth: {
          repository: repository({
            readCeremony: () => ({
              ...availableCeremony,
              expectedOrigin: relyingParty.publicOrigin,
              rpId: relyingParty.rpId,
            }),
            completeRegistration: () => 'registered',
          }),
          clock,
          random,
          identifiers,
          webauthn: {
            ...webauthn,
            verifyRegistration: async () => ({
              credentialId: webAuthnCredentialId('credential'),
              publicKey: new Uint8Array([1]),
              counter: 0,
              userVerified: true,
              transports: [],
              deviceType: 'singleDevice',
              backedUp: false,
            }),
          },
          relyingParty,
        },
      });
    const https = await successful();
    const secure = await https.inject({
      method: 'POST',
      url: '/api/auth/register/verify',
      headers: { cookie: 'gestalt_mobile_registration=correlation' },
      payload: { response: validProof, nickname: 'Device' },
    });
    const secureCookies = Array.isArray(secure.headers['set-cookie'])
      ? secure.headers['set-cookie'].join(';')
      : secure.headers['set-cookie'];
    expect(secureCookies).toContain('Secure');
    expect(secureCookies).toContain('HttpOnly');
    expect(secureCookies).toContain('SameSite=Strict');
    expect(secureCookies).toContain('Path=/');
    expect(secureCookies).toContain('Max-Age=2592000');
    await https.close();
    const localRp = { ...rp, publicOrigin: 'http://localhost:5173', rpId: 'localhost' };
    const local = await successful(localRp);
    const localResponse = await local.inject({
      method: 'POST',
      url: '/api/auth/register/verify',
      headers: { cookie: 'gestalt_mobile_registration=correlation' },
      payload: { response: validProof, nickname: 'Device' },
    });
    const localCookies = Array.isArray(localResponse.headers['set-cookie'])
      ? localResponse.headers['set-cookie'].join(';')
      : localResponse.headers['set-cookie'];
    expect(localCookies).not.toContain('Secure');
    await local.close();
  });

  it('validates each 32-byte owner, correlation, challenge, and session value before persistence or cookies', async () => {
    let saves = 0;
    const bytes = [new Uint8Array(32), new Uint8Array(32), new Uint8Array(31)];
    const optionsApp = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
      auth: {
        repository: repository({
          readOwner: () => null,
          saveCeremony: () => {
            saves++;
          },
        }),
        clock,
        random: { bytes: () => bytes.shift()! },
        identifiers,
        webauthn,
        relyingParty: rp,
      },
    });
    const options = await optionsApp.inject({
      method: 'POST',
      url: '/api/auth/register/options',
      payload: {},
    });
    expect(options.statusCode).toBe(500);
    expect(saves).toBe(0);
    expect(options.headers['set-cookie']).toBeUndefined();
    await optionsApp.close();
    const verifyApp = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
      auth: {
        repository: repository({
          readCeremony: () => availableCeremony,
          completeRegistration: () => {
            saves++;
            return 'registered';
          },
        }),
        clock,
        random,
        identifiers: { ...identifiers, sessionId: () => authorizationSessionId('short') },
        webauthn: {
          ...webauthn,
          verifyRegistration: async () => ({
            credentialId: webAuthnCredentialId('credential'),
            publicKey: new Uint8Array([1]),
            counter: 0,
            userVerified: true,
            transports: [],
            deviceType: 'singleDevice',
            backedUp: false,
          }),
        },
        relyingParty: rp,
      },
    });
    const verification = await verifyApp.inject({
      method: 'POST',
      url: '/api/auth/register/verify',
      headers: { cookie: 'gestalt_mobile_registration=correlation' },
      payload: { response: validProof, nickname: 'Device' },
    });
    expect(verification.statusCode).toBe(500);
    expect(saves).toBe(0);
    expect(verification.headers['set-cookie']).toBeUndefined();
    await verifyApp.close();
  });
});
