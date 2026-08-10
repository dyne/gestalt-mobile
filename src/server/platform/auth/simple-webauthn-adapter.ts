/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

import type {
  PasskeyOptions,
  PasskeyVerificationFailure,
  RegistrationOptionsInput,
  RegistrationVerification,
  WebAuthnCeremonyService,
} from '../../features/auth/application/ports.js';
import { PasskeyVerificationError } from '../../features/auth/application/ports.js';
import { webAuthnCredentialId } from '../../features/auth/domain/identifiers.js';

const transports = new Set(['ble', 'hybrid', 'internal', 'nfc', 'usb']);

function verificationFailure(error: unknown): PasskeyVerificationFailure {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('challenge')) return 'CHALLENGE_MISMATCH';
  if (message.includes('origin')) return 'ORIGIN_MISMATCH';
  if (message.includes('rp id') || message.includes('rpid')) return 'RP_ID_MISMATCH';
  if (message.includes('user presence')) return 'USER_PRESENCE_REQUIRED';
  if (message.includes('user verification')) return 'USER_VERIFICATION_REQUIRED';
  if (message.includes('credential id') || message.includes('base64'))
    return 'CREDENTIAL_ENCODING_INVALID';
  if (message.includes('alg') || message.includes('cose')) return 'ALGORITHM_UNSUPPORTED';
  if (
    message.includes('public key') ||
    message.includes('aaguid') ||
    message.includes('authenticator data')
  )
    return 'CREDENTIAL_MATERIAL_MISSING';
  if (message.includes('attestation')) return 'ATTESTATION_UNSUPPORTED';
  if (message.includes('signature')) return 'SIGNATURE_INVALID';
  return 'VERIFIER_REJECTED';
}

/** Translates SimpleWebAuthn DTOs at the platform boundary. */
export class SimpleWebAuthnAdapter implements WebAuthnCeremonyService {
  async registrationOptions(input: RegistrationOptionsInput): Promise<unknown> {
    return generateRegistrationOptions({
      rpName: input.rpName,
      rpID: input.rpId,
      userName: 'local-owner',
      userDisplayName: 'Local owner',
      userID: new Uint8Array(input.userHandle),
      challenge: new Uint8Array(input.challenge),
      attestationType: 'none',
      excludeCredentials: input.excludeCredentialIds.map((id) => ({ id })),
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      supportedAlgorithmIDs: [-7, -257],
    });
  }

  async authenticationOptions(input: PasskeyOptions): Promise<unknown> {
    return generateAuthenticationOptions({
      rpID: input.rpId,
      challenge: new Uint8Array(input.challenge),
      allowCredentials: [],
      userVerification: 'required',
    });
  }

  async verifyRegistration(input: {
    response: unknown;
    challenge: Uint8Array;
    expectedOrigin: string;
    rpId: string;
  }): Promise<RegistrationVerification> {
    let result;
    try {
      result = await verifyRegistrationResponse({
        response: input.response as RegistrationResponseJSON,
        expectedChallenge: Buffer.from(input.challenge).toString('base64url'),
        expectedOrigin: input.expectedOrigin,
        expectedRPID: input.rpId,
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7, -257],
      });
    } catch (error) {
      throw new PasskeyVerificationError(verificationFailure(error));
    }
    if (!result.verified || !result.registrationInfo?.userVerified)
      throw new PasskeyVerificationError('VERIFIER_REJECTED');
    const credential = result.registrationInfo.credential;
    return {
      credentialId: webAuthnCredentialId(credential.id),
      publicKey: new Uint8Array(credential.publicKey),
      counter: credential.counter,
      userVerified: result.registrationInfo.userVerified,
      transports: (credential.transports ?? []).filter(
        (value): value is 'ble' | 'hybrid' | 'internal' | 'nfc' | 'usb' => transports.has(value),
      ),
      deviceType: result.registrationInfo.credentialDeviceType,
      backedUp: result.registrationInfo.credentialBackedUp,
    };
  }

  async verifyAuthentication(input: unknown) {
    const value = input as {
      response: AuthenticationResponseJSON;
      challenge: Uint8Array;
      expectedOrigin: string;
      rpId: string;
      credential: {
        id: string;
        publicKey: Uint8Array;
        counter: number;
        transports: readonly ('ble' | 'hybrid' | 'internal' | 'nfc' | 'usb')[];
      };
    };
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response: value.response,
        expectedChallenge: Buffer.from(value.challenge).toString('base64url'),
        expectedOrigin: value.expectedOrigin,
        expectedRPID: value.rpId,
        requireUserVerification: true,
        credential: {
          id: value.credential.id,
          publicKey: new Uint8Array(
            value.credential.publicKey,
          ) as import('@simplewebauthn/server').Uint8Array_,
          counter: value.credential.counter,
          transports: [...value.credential.transports],
        },
      });
    } catch (error) {
      throw new PasskeyVerificationError(verificationFailure(error));
    }
    if (!result.verified || !result.authenticationInfo?.userVerified)
      throw new PasskeyVerificationError('VERIFIER_REJECTED');
    return {
      credentialId: webAuthnCredentialId(value.response.id),
      counter: result.authenticationInfo.newCounter,
      userVerified: result.authenticationInfo.userVerified,
    };
  }
}
