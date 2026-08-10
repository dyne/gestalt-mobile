/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { problem } from '../../../../platform/http/problem.js';
import {
  PasskeyVerificationError,
  type AuthorizationIdentifiers,
  type AuthorizationRepository,
  type Clock,
  type RandomBytes,
  type WebAuthnCeremonyService,
} from '../../application/ports.js';
import { deviceNickname } from '../../domain/device-nickname.js';
import { passkeyCeremonyId } from '../../domain/identifiers.js';
import { AuthorizationDomainError } from '../../domain/errors.js';
import { clearAuthCookie, setAuthCookie } from '../../http/cookies.js';

const registrationResponseSchema = z
  .object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: z.string().min(1),
        attestationObject: z.string().min(1),
        authenticatorData: z.string().min(1).optional(),
        transports: z
          .array(z.enum(['ble', 'hybrid', 'internal', 'nfc', 'usb', 'cable', 'smart-card']))
          .optional(),
        publicKeyAlgorithm: z.number().int().optional(),
        publicKey: z.string().min(1).optional(),
      })
      .strict(),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
    clientExtensionResults: z.record(z.string(), z.unknown()),
  })
  .strict();
const requestSchema = z
  .object({ response: registrationResponseSchema, nickname: z.string() })
  .strict();
const successSchema = z.object({ status: z.literal('authenticated') }).strict();
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;

export type RegistrationFailure =
  | 'INVALID_RESPONSE_SHAPE'
  | 'MISSING_CEREMONY_COOKIE'
  | 'CEREMONY_NOT_AVAILABLE'
  | 'USER_VERIFICATION_REQUIRED'
  | 'AUTHORIZATION_REJECTED'
  | `WEBAUTHN_${import('../../application/ports.js').PasskeyVerificationFailure}`;

export function registerRegistrationVerification(
  app: FastifyInstance,
  deps: {
    repository: AuthorizationRepository;
    clock: Clock;
    random: RandomBytes;
    identifiers: AuthorizationIdentifiers;
    webauthn: WebAuthnCeremonyService;
    relyingParty: { publicOrigin: string; rpId: string };
    reportVerificationFailure?: (reason: RegistrationFailure) => void;
  },
): void {
  app.post('/api/auth/register/verify', { bodyLimit: 128 * 1024 }, async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body);
    const token = request.cookies.gestalt_mobile_registration;
    if (!parsed.success) {
      deps.reportVerificationFailure?.('INVALID_RESPONSE_SHAPE');
      return reply
        .code(400)
        .type('application/problem+json')
        .send(problem('INVALID_REGISTRATION_REQUEST', 400, 'The registration request is invalid.'));
    }
    if (typeof token !== 'string') {
      deps.reportVerificationFailure?.('MISSING_CEREMONY_COOKIE');
      return reply
        .code(400)
        .type('application/problem+json')
        .send(problem('REGISTRATION_COOKIE_MISSING', 400, 'The registration cookie is missing.'));
    }
    let nickname;
    try {
      nickname = deviceNickname(parsed.data.nickname);
    } catch (error) {
      if (error instanceof AuthorizationDomainError)
        return reply
          .code(400)
          .type('application/problem+json')
          .send(problem('INVALID_DEVICE_NICKNAME', 400, 'The device nickname is invalid.'));
      throw error;
    }
    const now = deps.clock.now();
    const ceremony = deps.repository.readCeremony(passkeyCeremonyId(token), now.toISOString());
    if (!ceremony || ceremony.purpose !== 'registration') {
      deps.reportVerificationFailure?.('CEREMONY_NOT_AVAILABLE');
      return reply
        .code(400)
        .type('application/problem+json')
        .send(problem('REGISTRATION_NOT_AVAILABLE', 400, 'Registration could not be completed.'));
    }
    try {
      const verified = await deps.webauthn.verifyRegistration({
        response: parsed.data.response,
        challenge: ceremony.challenge,
        expectedOrigin: ceremony.expectedOrigin,
        rpId: ceremony.rpId,
      });
      if (!verified.userVerified)
        throw new PasskeyVerificationError('USER_VERIFICATION_REQUIRED');
      const device = {
        id: deps.identifiers.deviceId(),
        credentialId: verified.credentialId,
        publicKey: verified.publicKey,
        counter: verified.counter,
        transports: verified.transports,
        deviceType: verified.deviceType,
        backedUp: verified.backedUp,
        nickname,
        createdAt: now.toISOString(),
      } as const;
      const session = deps.identifiers.sessionId();
      if (Buffer.from(session, 'base64url').length !== 32)
        throw new Error('AUTHORIZATION_RANDOMNESS_INVALID');
      const expiresAt = new Date(now.getTime() + sessionLifetimeMs).toISOString();
      const outcome = deps.repository.completeRegistration({
        ceremony: passkeyCeremonyId(token),
        now: now.toISOString(),
        device,
        session: { id: session, deviceId: device.id, expiresAt },
      });
      if (outcome !== 'registered')
        return reply
          .code(outcome === 'bootstrapAlreadyClaimed' ? 409 : 400)
          .type('application/problem+json')
          .send(
            problem(
              outcome === 'bootstrapAlreadyClaimed'
                ? 'BOOTSTRAP_ALREADY_CLAIMED'
                : 'REGISTRATION_NOT_AVAILABLE',
              outcome === 'bootstrapAlreadyClaimed' ? 409 : 400,
              'Registration could not be completed.',
            ),
          );
      setAuthCookie(reply, 'gestalt_mobile_session', session, deps.relyingParty.publicOrigin);
      clearAuthCookie(reply, 'gestalt_mobile_registration', deps.relyingParty.publicOrigin);
      return reply.code(201).send(successSchema.parse({ status: 'authenticated' }));
    } catch (error) {
      if (error instanceof PasskeyVerificationError || error instanceof AuthorizationDomainError) {
        deps.reportVerificationFailure?.(
          error instanceof PasskeyVerificationError
            ? `WEBAUTHN_${error.reason}`
            : 'AUTHORIZATION_REJECTED',
        );
        return reply
          .code(400)
          .type('application/problem+json')
          .send(
            problem(
              'REGISTRATION_VERIFICATION_FAILED',
              400,
              'Registration could not be completed.',
            ),
          );
      }
      throw error;
    }
  });
}
