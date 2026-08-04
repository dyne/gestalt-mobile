/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import cookie from '@fastify/cookie';
import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../../app.js';
import {
  PasskeyVerificationError,
  type AuthorizationRepository,
  type WebAuthnCeremonyService,
} from '../application/ports.js';
import {
  authorizationSessionId,
  authorizedDeviceId,
  localOwnerId,
  passkeyCeremonyId,
  webAuthnCredentialId,
} from '../domain/identifiers.js';
import { deviceNickname } from '../domain/device-nickname.js';
import { registerLogout } from '../logout/endpoint.js';
import { registerAuthStatus } from '../status/endpoint.js';

const rp = { publicOrigin: 'https://gestalt.example', rpId: 'gestalt.example', rpName: 'Gestalt' };
const clock = { now: () => new Date('2026-08-02T00:00:00.000Z') };
const device = {
  id: authorizedDeviceId('device'),
  credentialId: webAuthnCredentialId('credential'),
  publicKey: new Uint8Array([1]),
  counter: 0,
  version: 0,
  transports: ['internal'] as const,
  deviceType: 'singleDevice' as const,
  backedUp: false,
  nickname: deviceNickname('Device'),
  createdAt: '2026-08-01T00:00:00.000Z',
};
const ceremony = {
  id: passkeyCeremonyId('login'),
  purpose: 'authentication' as const,
  challenge: new Uint8Array([1, 2]),
  expectedOrigin: rp.publicOrigin,
  rpId: rp.rpId,
  expiresAt: '2026-08-03T00:00:00.000Z',
};
const proof = {
  id: 'credential',
  rawId: 'raw',
  type: 'public-key' as const,
  response: { clientDataJSON: 'data', authenticatorData: 'auth', signature: 'sig' },
  clientExtensionResults: {},
};
function repo(overrides: Partial<AuthorizationRepository> = {}): AuthorizationRepository {
  return {
    initializeOwner: (userHandle) => ({ id: localOwnerId('owner'), userHandle }),
    readOwner: () => null,
    listAuthorizedDevices: () => [device],
    claimFirstDevice: () => 'claimed',
    authorizeDevice: () => 'authorized',
    findDeviceByCredentialId: () => device,
    findDevice: () => device,
    renameDevice: () => 'notFound',
    advanceCounter: () => true,
    revokeDevice: () => 'notFound',
    saveCeremony: () => {},
    consumeCeremony: () => null,
    readCeremony: () => ceremony,
    saveTicket: () => {},
    issueEnrollmentTicket: () => {},
    enrollmentTicketStatus: () => 'none', cancelEnrollmentTicket: () => false,
    consumeTicket: () => false,
    ticketAvailable: () => false,
    completeRegistration: () => 'ceremonyUnavailable',
    completeAuthentication: () => true,
    saveSession: () => {},
    sessionDevice: () => null,
    revokeSession: () => true,
    close: () => {},
    ...overrides,
  };
}
const webauthn: WebAuthnCeremonyService = {
  registrationOptions: async () => ({}),
  authenticationOptions: async () => ({ challenge: 'server' }),
  verifyRegistration: async () => {
    throw new Error('unused');
  },
  verifyAuthentication: async () => ({
    credentialId: device.credentialId,
    counter: 1,
    userVerified: true,
  }),
};
async function app(repository = repo(), service = webauthn, relyingParty = rp) {
  const instance = await buildApp({
    health: {
      read: async () => ({
        status: 'ok',
        version: 'test',
        codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
      }),
    },
    logger: console,
    auth: {
      repository,
      clock,
      random: { bytes: () => new Uint8Array(32).fill(7) },
      identifiers: {
        deviceId: () => device.id,
        sessionId: () =>
          authorizationSessionId(Buffer.from(new Uint8Array(32).fill(9)).toString('base64url')),
      },
      webauthn: service,
      relyingParty,
    },
  });
  const inject = instance.inject.bind(instance) as (options: unknown) => Promise<unknown>;
  instance.inject = ((options: string | { headers?: Record<string, string>; [key: string]: unknown }) => {
    if (typeof options === 'string') return inject(options);
    return inject({
      ...options,
      headers: { origin: relyingParty.publicOrigin, ...options.headers },
    });
  }) as never;
  return instance;
}
describe('login endpoints', () => {
  it('issues discoverable options and only a server-held login cookie', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/auth/login/options',
      headers: { origin: rp.publicOrigin },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ options: { challenge: 'server' } });
    expect(response.headers['set-cookie']).toContain('gestalt_mobile_login=');
    await instance.close();
  });
  it('stores the exact server-held authentication policy after issuing empty-allow-list options', async () => {
    let stored: unknown;
    let policy: unknown;
    const instance = await app(
      repo({
        saveCeremony: (_token, value) => {
          stored = value;
        },
      }),
      {
        ...webauthn,
        authenticationOptions: async (input) => {
          policy = input;
          return { challenge: 'server' };
        },
      },
    );
    await instance.inject({ method: 'POST', url: '/api/auth/login/options' });
    expect(stored).toMatchObject({
      purpose: 'authentication',
      expectedOrigin: rp.publicOrigin,
      rpId: rp.rpId,
      challenge: new Uint8Array(32).fill(7),
    });
    expect(policy).toEqual({
      challenge: new Uint8Array(32).fill(7),
      rpId: rp.rpId,
      userVerification: 'required',
    });
    await instance.close();
  });
  it('uses two independent 32-byte values and leaves no artifact when entropy or options fail', async () => {
    const calls: number[] = [];
    let saved = 0;
    const instance = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
      auth: {
        repository: repo({
          saveCeremony: () => {
            saved++;
          },
        }),
        clock,
        random: {
          bytes: (length) => {
            calls.push(length);
            return calls.length === 1 ? new Uint8Array(32) : new Uint8Array(31);
          },
        },
        identifiers: {
          deviceId: () => device.id,
          sessionId: () => authorizationSessionId('unused'),
        },
        webauthn,
        relyingParty: rp,
      },
    });
    const response = await instance.inject({
      method: 'POST',
      url: '/api/auth/login/options',
      headers: { origin: rp.publicOrigin },
    });
    expect(response.statusCode).toBe(500);
    expect(calls).toEqual([32, 32]);
    expect(saved).toBe(0);
    expect(response.headers['set-cookie']).toBeUndefined();
    await instance.close();
  });
  it('does not create a ceremony or cookie when authentication options violate the response schema', async () => {
    let saved = 0;
    const instance = await app(
      repo({
        saveCeremony: () => {
          saved++;
        },
      }),
      {
        ...webauthn,
        authenticationOptions: async () => ({ unexpected: true }),
      },
    );
    const response = await instance.inject({ method: 'POST', url: '/api/auth/login/options' });
    expect(response.statusCode).toBe(500);
    expect(saved).toBe(0);
    expect(response.headers['set-cookie']).toBeUndefined();
    await instance.close();
  });
  it('does not create a ceremony or cookie when the WebAuthn adapter rejects', async () => {
    let saved = 0;
    const instance = await app(
      repo({
        saveCeremony: () => {
          saved++;
        },
      }),
      {
        ...webauthn,
        authenticationOptions: async () => {
          throw new Error('adapter failure');
        },
      },
    );
    const response = await instance.inject({ method: 'POST', url: '/api/auth/login/options' });
    expect(response.statusCode).toBe(500);
    expect(saved).toBe(0);
    expect(response.headers['set-cookie']).toBeUndefined();
    await instance.close();
  });
  it('uses stored ceremony and device policy, then atomically issues a 30-day secure session', async () => {
    let input: unknown;
    let completion: unknown;
    const instance = await app(
      repo({
        completeAuthentication: (value) => {
          completion = value;
          return true;
        },
      }),
      {
        ...webauthn,
        verifyAuthentication: async (value) => {
          input = value;
          return { credentialId: device.credentialId, counter: 1, userVerified: true };
        },
      },
    );
    const response = await instance.inject({
      method: 'POST',
      url: '/api/auth/login/verify',
      headers: { cookie: 'gestalt_mobile_login=login', origin: rp.publicOrigin },
      payload: { response: proof },
    });
    const cookies = Array.isArray(response.headers['set-cookie'])
      ? response.headers['set-cookie'].join(';')
      : response.headers['set-cookie'];
    expect(response.statusCode).toBe(200);
    expect(input).toMatchObject({
      challenge: ceremony.challenge,
      expectedOrigin: rp.publicOrigin,
      rpId: rp.rpId,
      credential: { publicKey: device.publicKey, counter: 0 },
    });
    expect(cookies).toContain('Max-Age=2592000');
    expect(cookies).toContain('Secure');
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('SameSite=Strict');
    expect(cookies).toContain('Path=/');
    expect(completion).toMatchObject({
      session: { expiresAt: '2026-09-01T00:00:00.000Z' },
    });
    await instance.close();
  });
  it('accepts the browser authentication response shape and resolves its base64url credential ID', async () => {
    const credentialId = webAuthnCredentialId('Y3JlZGVudGlhbC1mcm9tLWJyb3dzZXI');
    const browserDevice = { ...device, credentialId, publicKey: new Uint8Array([7, 8]) };
    let resolved: unknown;
    let verified: unknown;
    const instance = await app(
      repo({
        findDeviceByCredentialId: (id) => {
          resolved = id;
          return id === credentialId ? browserDevice : null;
        },
      }),
      {
        ...webauthn,
        verifyAuthentication: async (input) => {
          verified = input;
          return { credentialId, counter: 0, userVerified: true };
        },
      },
    );
    const response = await instance.inject({
      method: 'POST',
      url: '/api/auth/login/verify',
      headers: { cookie: 'gestalt_mobile_login=login' },
      payload: {
        response: {
          id: credentialId,
          rawId: credentialId,
          type: 'public-key',
          response: {
            clientDataJSON: 'Y2xpZW50LWRhdGE',
            authenticatorData: 'YXV0aGVudGljYXRvci1kYXRh',
            signature: 'c2lnbmF0dXJl',
            userHandle: 'bG9jYWwtb3duZXI',
          },
          clientExtensionResults: {},
          authenticatorAttachment: 'platform',
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(resolved).toBe(credentialId);
    expect(verified).toMatchObject({
      response: { id: credentialId, authenticatorAttachment: 'platform' },
      credential: { id: credentialId, publicKey: browserDevice.publicKey, counter: 0 },
    });
    await instance.close();
  });
  it('returns one non-enumerating failure without mutation or cookie for unknown, expired, replayed, and UV failures', async () => {
    let writes = 0;
    const instance = await app(
      repo({
        findDeviceByCredentialId: () => null,
        completeAuthentication: () => {
          writes++;
          return true;
        },
      }),
    );
    for (const token of ['login', 'missing']) {
      const response = await instance.inject({
        method: 'POST',
        url: '/api/auth/login/verify',
        headers: { cookie: `gestalt_mobile_login=${token}` },
        payload: { response: proof },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('AUTHENTICATION_FAILED');
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(writes).toBe(0);
    await instance.close();
  });
  it.each([
    ['unknown credential', repo({ findDeviceByCredentialId: () => null }), webauthn],
    ['removed credential', repo({ findDeviceByCredentialId: () => null }), webauthn],
    ['expired ceremony', repo({ readCeremony: () => null }), webauthn],
    [
      'wrong-purpose ceremony',
      repo({ readCeremony: () => ({ ...ceremony, purpose: 'registration' }) }),
      webauthn,
    ],
    ['replayed ceremony', repo({ completeAuthentication: () => false }), webauthn],
    [
      'verifier error',
      repo(),
      {
        ...webauthn,
        verifyAuthentication: async () => {
          throw new PasskeyVerificationError('invalid');
        },
      },
    ],
    [
      'missing UV',
      repo(),
      {
        ...webauthn,
        verifyAuthentication: async () => ({
          credentialId: device.credentialId,
          counter: 1,
          userVerified: undefined as unknown as boolean,
        }),
      },
    ],
    [
      'false UV',
      repo(),
      {
        ...webauthn,
        verifyAuthentication: async () => ({
          credentialId: device.credentialId,
          counter: 1,
          userVerified: false,
        }),
      },
    ],
    [
      'returned credential mismatch',
      repo(),
      {
        ...webauthn,
        verifyAuthentication: async () => ({
          credentialId: webAuthnCredentialId('other'),
          counter: 1,
          userVerified: true,
        }),
      },
    ],
    ['counter CAS failure', repo({ completeAuthentication: () => false }), webauthn],
  ])(
    'uses the identical non-enumerating failure contract for %s',
    async (caseName, repository, service) => {
      let completions = 0;
      const wrapped = repo({
        ...repository,
        completeAuthentication: (input) => {
          completions++;
          return repository.completeAuthentication(input);
        },
      });
      const instance = await app(wrapped, service);
      const response = await instance.inject({
        method: 'POST',
        url: '/api/auth/login/verify',
        headers: { cookie: 'gestalt_mobile_login=login' },
        payload: { response: proof },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        type: 'urn:gestalt-mobile:error:authentication_failed',
        title: 'AUTHENTICATION FAILED',
        status: 400,
        code: 'AUTHENTICATION_FAILED',
        detail: 'Authentication could not be completed.',
        retryable: false,
      });
      expect(response.headers['set-cookie']).toBeUndefined();
      if (
        [
          'unknown credential',
          'removed credential',
          'expired ceremony',
          'wrong-purpose ceremony',
          'verifier error',
          'missing UV',
          'false UV',
          'returned credential mismatch',
        ].includes(caseName)
      )
        expect(completions).toBe(0);
      await instance.close();
    },
  );
  it('rejects an incorrectly sized session identifier without completion or a cookie', async () => {
    let completed = 0;
    const malformed = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: null, protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
      auth: {
        repository: repo({
          completeAuthentication: () => {
            completed++;
            return true;
          },
        }),
        clock,
        random: { bytes: () => new Uint8Array(32) },
        identifiers: {
          deviceId: () => device.id,
          sessionId: () => authorizationSessionId('short'),
        },
        webauthn,
        relyingParty: rp,
      },
    });
    const response = await malformed.inject({
      method: 'POST',
      url: '/api/auth/login/verify',
      headers: { cookie: 'gestalt_mobile_login=login', origin: rp.publicOrigin },
      payload: { response: proof },
    });
    expect(response.statusCode).toBe(500);
    expect(completed).toBe(0);
    expect(response.headers['set-cookie']).toBeUndefined();
    await malformed.close();
  });
  it('rejects malformed request shapes before verification or session mutation', async () => {
    let completed = 0;
    const instance = await app(
      repo({
        completeAuthentication: () => {
          completed++;
          return true;
        },
      }),
    );
    const response = await instance.inject({
      method: 'POST',
      url: '/api/auth/login/verify',
      headers: { cookie: 'gestalt_mobile_login=login' },
      payload: { response: { ...proof, unexpected: true } },
    });
    expect(response.json().code).toBe('AUTHENTICATION_FAILED');
    expect(completed).toBe(0);
    expect(response.headers['set-cookie']).toBeUndefined();
    await instance.close();
  });
  it('reports only bootstrap, locked, or authenticated status and logs out by revoking the shared token', async () => {
    let revoked = false;
    const bootstrap = await app(repo({ listAuthorizedDevices: () => [] }));
    expect((await bootstrap.inject({ method: 'GET', url: '/api/auth/status' })).json()).toEqual({
      status: 'bootstrap',
      publicOrigin: rp.publicOrigin,
    });
    await bootstrap.close();
    const instance = await app(
      repo({
        sessionDevice: (token) => (token === authorizationSessionId('live') ? device.id : null),
        revokeSession: () => (revoked = true),
        listAuthorizedDevices: () => [device],
      }),
    );
    expect((await instance.inject({ method: 'GET', url: '/api/auth/status' })).json()).toEqual({
      status: 'locked',
      publicOrigin: rp.publicOrigin,
    });
    expect(
      (
        await instance.inject({
          method: 'GET',
          url: '/api/auth/status',
          headers: { cookie: 'gestalt_mobile_session=live' },
        })
      ).json(),
    ).toEqual({ status: 'authenticated', publicOrigin: rp.publicOrigin });
    const logout = await instance.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: 'gestalt_mobile_session=live' },
    });
    expect(logout.statusCode).toBe(204);
    expect(revoked).toBe(true);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    expect(logout.headers['set-cookie']).toContain('Secure');
    expect(logout.headers['set-cookie']).toContain('HttpOnly');
    expect(logout.headers['set-cookie']).toContain('SameSite=Strict');
    await instance.close();
  });
  it('treats malformed session cookies as locked and clears them without revocation', async () => {
    const instance = fastify();
    await instance.register(cookie);
    instance.addHook('preHandler', async (request) => {
      request.cookies.gestalt_mobile_session = ' forged';
    });
    let repositoryCalls = 0;
    const repository = repo({
      sessionDevice: () => { repositoryCalls++; return device.id; },
      revokeSession: () => { repositoryCalls++; return true; },
      listAuthorizedDevices: () => [device],
    });
    registerAuthStatus(instance, { repository, clock, relyingParty: rp });
    registerLogout(instance, { repository, clock, relyingParty: rp });
    const status = await instance.inject({ method: 'GET', url: '/api/auth/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ status: 'locked', publicOrigin: rp.publicOrigin });
    const logout = await instance.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    expect(repositoryCalls).toBe(0);
    await instance.close();
  });
  it.each(['expired', 'device-revoked'])(
    'reports a %s session as locked without credential data',
    async () => {
      const instance = await app(repo({ sessionDevice: () => null }));
      const response = await instance.inject({
        method: 'GET',
        url: '/api/auth/status',
        headers: { cookie: 'gestalt_mobile_session=invalidated' },
      });
      expect(response.json()).toEqual({ status: 'locked', publicOrigin: rp.publicOrigin });
      await instance.close();
    },
  );
  it('omits Secure but retains the cookie contract for localhost login and logout', async () => {
    const local = { publicOrigin: 'http://localhost:4173', rpId: 'localhost', rpName: 'Gestalt' };
    const instance = await app(
      repo({
        sessionDevice: (token) => (token === authorizationSessionId('live') ? device.id : null),
      }),
      webauthn,
      local,
    );
    const login = await instance.inject({
      method: 'POST',
      url: '/api/auth/login/verify',
      headers: { cookie: 'gestalt_mobile_login=login' },
      payload: { response: proof },
    });
    const loginCookies = Array.isArray(login.headers['set-cookie'])
      ? login.headers['set-cookie'].join(';')
      : login.headers['set-cookie'];
    expect(loginCookies).not.toContain('Secure');
    expect(loginCookies).toContain('HttpOnly');
    expect(loginCookies).toContain('SameSite=Strict');
    expect(loginCookies).toContain('Path=/');
    expect(loginCookies).toContain('Max-Age=2592000');
    const logout = await instance.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: 'gestalt_mobile_session=live' },
    });
    expect(logout.headers['set-cookie']).not.toContain('Secure');
    expect(logout.headers['set-cookie']).toContain('HttpOnly');
    expect(logout.headers['set-cookie']).toContain('SameSite=Strict');
    expect(logout.headers['set-cookie']).toContain('Path=/');
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    await instance.close();
  });
  it('keeps realistic proof and cookie values out of its stable authentication failure response', async () => {
    const error = vi.spyOn(console, 'error');
    const instance = await app(repo({ findDeviceByCredentialId: () => null }));
    const response = await instance.inject({
      method: 'POST',
      url: '/api/auth/login/verify',
      headers: { cookie: 'gestalt_mobile_login=ceremony-secret' },
      payload: {
        response: {
          ...proof,
          id: 'credential-secret',
          response: {
            ...proof.response,
            signature: 'signature-secret',
            userHandle: 'owner-secret',
          },
        },
      },
    });
    expect(response.body).not.toContain('credential-secret');
    expect(response.body).not.toContain('ceremony-secret');
    expect(response.body).not.toContain('signature-secret');
    expect(response.body).not.toContain('owner-secret');
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
    await instance.close();
  });
});
