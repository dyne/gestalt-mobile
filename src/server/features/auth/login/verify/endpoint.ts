/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendProblem } from '../../../../platform/http/problem-reply.js';
import {
  PasskeyVerificationError,
  type AuthorizationIdentifiers,
  type AuthorizationRepository,
  type Clock,
  type WebAuthnCeremonyService,
} from '../../application/ports.js';
import { passkeyCeremonyId, webAuthnCredentialId } from '../../domain/identifiers.js';
import { clearAuthCookie, setAuthCookie } from '../../http/cookies.js';

const responseSchema = z
  .object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: z.string().min(1),
        authenticatorData: z.string().min(1),
        signature: z.string().min(1),
        userHandle: z.string().nullable().optional(),
      })
      .strict(),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
    clientExtensionResults: z.record(z.string(), z.unknown()),
  })
  .strict();
const requestSchema = z.object({ response: responseSchema }).strict();
const lifetimeMs = 30 * 24 * 60 * 60 * 1000;

export function registerLoginVerification(
  app: FastifyInstance,
  deps: {
    repository: AuthorizationRepository;
    clock: Clock;
    identifiers: AuthorizationIdentifiers;
    webauthn: WebAuthnCeremonyService;
    relyingParty: { publicOrigin: string };
  },
): void {
  app.post('/api/auth/login/verify', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body);
    const token = request.cookies.gestalt_mobile_login;
    const fail = () =>
      sendProblem(reply, 'AUTHENTICATION_FAILED', 400, 'Authentication could not be completed.');
    if (!parsed.success || typeof token !== 'string') return fail();
    const now = deps.clock.now();
    const ceremony = deps.repository.readCeremony(passkeyCeremonyId(token), now.toISOString());
    if (!ceremony || ceremony.purpose !== 'authentication') return fail();
    const device = deps.repository.findDeviceByCredentialId(
      webAuthnCredentialId(parsed.data.response.id),
    );
    if (!device) return fail();
    try {
      const verified = await deps.webauthn.verifyAuthentication({
        response: parsed.data.response,
        challenge: ceremony.challenge,
        expectedOrigin: ceremony.expectedOrigin,
        rpId: ceremony.rpId,
        credential: {
          id: device.credentialId,
          publicKey: device.publicKey,
          counter: device.counter,
          transports: device.transports,
        },
      });
      if (!verified.userVerified || verified.credentialId !== device.credentialId)
        throw new PasskeyVerificationError('USER_VERIFICATION_REQUIRED');
      const session = deps.identifiers.sessionId();
      if (Buffer.from(session, 'base64url').length !== 32)
        throw new Error('AUTHORIZATION_RANDOMNESS_INVALID');
      const authenticated = deps.repository.completeAuthentication({
        ceremony: passkeyCeremonyId(token),
        now: now.toISOString(),
        device,
        nextCounter: verified.counter,
        session: {
          id: session,
          deviceId: device.id,
          expiresAt: new Date(now.getTime() + lifetimeMs).toISOString(),
        },
      });
      if (!authenticated) return fail();
      setAuthCookie(reply, 'gestalt_mobile_session', session, deps.relyingParty.publicOrigin);
      clearAuthCookie(reply, 'gestalt_mobile_login', deps.relyingParty.publicOrigin);
      return reply.send({ status: 'authenticated' });
    } catch (error) {
      if (error instanceof PasskeyVerificationError) return fail();
      throw error;
    }
  });
}
