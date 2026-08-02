/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyRegistrationResponse: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));
vi.mock('@simplewebauthn/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simplewebauthn/server')>()),
  verifyRegistrationResponse: mocks.verifyRegistrationResponse,
  verifyAuthenticationResponse: mocks.verifyAuthenticationResponse,
}));

import { PasskeyVerificationError } from '../../features/auth/application/ports.js';
import { webAuthnCredentialId } from '../../features/auth/domain/identifiers.js';
import { SimpleWebAuthnAdapter } from './simple-webauthn-adapter.js';

describe('SimpleWebAuthnAdapter', () => {
  it('generates discoverable, user-verified registration options with the required algorithms', async () => {
    const adapter = new SimpleWebAuthnAdapter();
    const options = (await adapter.registrationOptions({
      challenge: new Uint8Array(32).fill(1),
      rpId: 'gestalt.example',
      userVerification: 'required',
      rpName: 'Gestalt Mobile',
      userHandle: new Uint8Array(32).fill(2),
      excludeCredentialIds: [webAuthnCredentialId('credential')],
    })) as {
      attestation: string;
      pubKeyCredParams: { alg: number }[];
      authenticatorSelection: {
        residentKey: string;
        requireResidentKey: boolean;
        userVerification: string;
      };
      excludeCredentials: { id: string }[];
    };
    expect(options.attestation).toBe('none');
    expect(options.pubKeyCredParams.map((entry) => entry.alg)).toEqual([-7, -257]);
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    });
    expect(options.excludeCredentials).toEqual([{ id: 'credential', type: 'public-key' }]);
  });

  it('generates username-free authentication options with required user verification', async () => {
    const options = (await new SimpleWebAuthnAdapter().authenticationOptions({
      challenge: new Uint8Array(32).fill(1),
      rpId: 'gestalt.example',
      userVerification: 'required',
    })) as { allowCredentials?: unknown[]; userVerification: string };
    expect(options.allowCredentials).toEqual([]);
    expect(options.userVerification).toBe('required');
  });

  it('maps the installed registration result and supplies only server-held verification policy', async () => {
    mocks.verifyRegistrationResponse.mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'credential',
          publicKey: new Uint8Array([9, 8]),
          counter: 4,
          transports: ['internal'],
        },
        userVerified: true,
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
      },
    } as never);
    const result = await new SimpleWebAuthnAdapter().verifyRegistration({
      response: {
        id: 'browser',
        rawId: 'browser',
        type: 'public-key',
        response: { clientDataJSON: 'client', attestationObject: 'attestation' },
        clientExtensionResults: {},
      },
      challenge: new Uint8Array([1, 2]),
      expectedOrigin: 'https://gestalt.example',
      rpId: 'gestalt.example',
    });
    expect(mocks.verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: 'AQI',
        expectedOrigin: 'https://gestalt.example',
        expectedRPID: 'gestalt.example',
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7, -257],
      }),
    );
    expect(result).toMatchObject({
      credentialId: 'credential',
      publicKey: new Uint8Array([9, 8]),
      counter: 4,
      transports: ['internal'],
      deviceType: 'multiDevice',
      backedUp: true,
    });
  });

  it.each([
    [
      'a thrown verifier failure',
      () => mocks.verifyRegistrationResponse.mockRejectedValueOnce(new Error('library failure')),
    ],
    [
      'an unverified result',
      () => mocks.verifyRegistrationResponse.mockResolvedValueOnce({ verified: false } as never),
    ],
    [
      'missing user verification',
      () =>
        mocks.verifyRegistrationResponse.mockResolvedValueOnce({
          verified: true,
          registrationInfo: {
            credential: { id: 'credential', publicKey: new Uint8Array([1]), counter: 0 },
            userVerified: undefined,
          },
        } as never),
    ],
    [
      'false user verification',
      () =>
        mocks.verifyRegistrationResponse.mockResolvedValueOnce({
          verified: true,
          registrationInfo: {
            credential: { id: 'credential', publicKey: new Uint8Array([1]), counter: 0 },
            userVerified: false,
          },
        } as never),
    ],
  ])(
    'returns PasskeyVerificationError without mapping a credential for %s',
    async (_caseName, arrange) => {
      arrange();
      await expect(
        new SimpleWebAuthnAdapter().verifyRegistration({
          response: {},
          challenge: new Uint8Array([1]),
          expectedOrigin: 'https://gestalt.example',
          rpId: 'gestalt.example',
        }),
      ).rejects.toBeInstanceOf(PasskeyVerificationError);
    },
  );

  it('supplies exact server-held authentication policy and stored credential material', async () => {
    mocks.verifyAuthenticationResponse.mockResolvedValueOnce({
      verified: true,
      authenticationInfo: { newCounter: 9, userVerified: true },
    } as never);
    const response = {
      id: 'credential',
      rawId: 'credential',
      type: 'public-key',
      response: {
        clientDataJSON: 'client',
        authenticatorData: 'auth',
        signature: 'signature',
        userHandle: 'owner',
      },
      clientExtensionResults: {},
    };
    const result = await new SimpleWebAuthnAdapter().verifyAuthentication({
      response,
      challenge: new Uint8Array([1, 2]),
      expectedOrigin: 'https://gestalt.example:8443',
      rpId: 'gestalt.example',
      credential: {
        id: 'credential',
        publicKey: new Uint8Array([8, 7]),
        counter: 4,
        transports: ['internal', 'usb'],
      },
    });
    expect(mocks.verifyAuthenticationResponse).toHaveBeenCalledWith({
      response,
      expectedChallenge: 'AQI',
      expectedOrigin: 'https://gestalt.example:8443',
      expectedRPID: 'gestalt.example',
      requireUserVerification: true,
      credential: {
        id: 'credential',
        publicKey: new Uint8Array([8, 7]),
        counter: 4,
        transports: ['internal', 'usb'],
      },
    });
    expect(result).toEqual({ credentialId: 'credential', counter: 9, userVerified: true });
  });

  it.each([
    [
      'a thrown verifier failure',
      () => mocks.verifyAuthenticationResponse.mockRejectedValueOnce(new Error('library failure')),
    ],
    [
      'an unverified result',
      () => mocks.verifyAuthenticationResponse.mockResolvedValueOnce({ verified: false } as never),
    ],
    [
      'missing user verification',
      () =>
        mocks.verifyAuthenticationResponse.mockResolvedValueOnce({
          verified: true,
          authenticationInfo: { newCounter: 2 },
        } as never),
    ],
    [
      'false user verification',
      () =>
        mocks.verifyAuthenticationResponse.mockResolvedValueOnce({
          verified: true,
          authenticationInfo: { newCounter: 2, userVerified: false },
        } as never),
    ],
  ])(
    'returns PasskeyVerificationError without mapping authentication for %s',
    async (_caseName, arrange) => {
      arrange();
      await expect(
        new SimpleWebAuthnAdapter().verifyAuthentication({
          response: { id: 'credential' },
          challenge: new Uint8Array([1]),
          expectedOrigin: 'https://gestalt.example',
          rpId: 'gestalt.example',
          credential: {
            id: 'credential',
            publicKey: new Uint8Array([1]),
            counter: 0,
            transports: [],
          },
        }),
      ).rejects.toBeInstanceOf(PasskeyVerificationError);
    },
  );
});
