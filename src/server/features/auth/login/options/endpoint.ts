/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendProblem } from '../../../../platform/http/problem-reply.js';
import type {
  AuthorizationRepository,
  Clock,
  RandomBytes,
  WebAuthnCeremonyService,
} from '../../application/ports.js';
import { passkeyCeremonyId } from '../../domain/identifiers.js';
import { CeremonyCapacityError } from '../../domain/errors.js';
import { setAuthCookie } from '../../http/cookies.js';
import type { CeremonyAttemptGate } from '../../application/ceremony-attempts.js';

const lifetimeMs = 10 * 60 * 1000;
const responseSchema = z
  .object({ options: z.object({ challenge: z.string().min(1) }).passthrough() })
  .strict();

export function registerLoginOptions(
  app: FastifyInstance,
  deps: {
    repository: AuthorizationRepository;
    clock: Clock;
    random: RandomBytes;
    webauthn: WebAuthnCeremonyService;
    relyingParty: { publicOrigin: string; rpId: string };
    ceremonyAttempts: CeremonyAttemptGate;
  },
): void {
  app.post('/api/auth/login/options', { bodyLimit: 1024 }, async (request, reply) => {
    if (!deps.ceremonyAttempts.allow(`login:${request.ip}`, deps.clock.now()))
      return sendProblem(
        reply,
        'AUTHENTICATION_FAILED',
        400,
        'Authentication could not be completed.',
      );
    if (deps.repository.listAuthorizedDevices().length === 0)
      return sendProblem(
        reply,
        'AUTHENTICATION_FAILED',
        400,
        'Authentication could not be completed.',
      );
    const correlation = deps.random.bytes(32);
    const challenge = deps.random.bytes(32);
    if (correlation.length !== 32 || challenge.length !== 32)
      throw new Error('AUTHORIZATION_RANDOMNESS_INVALID');
    const now = deps.clock.now();
    const options = responseSchema.parse({
      options: await deps.webauthn.authenticationOptions({
        challenge,
        rpId: deps.relyingParty.rpId,
        userVerification: 'required',
      }),
    });
    const token = passkeyCeremonyId(Buffer.from(correlation).toString('base64url'));
    try {
      deps.repository.saveCeremony(
        token,
        {
          purpose: 'authentication',
          challenge,
          expectedOrigin: deps.relyingParty.publicOrigin,
          rpId: deps.relyingParty.rpId,
          expiresAt: new Date(now.getTime() + lifetimeMs).toISOString(),
        },
        now.toISOString(),
      );
    } catch (error) {
      if (error instanceof CeremonyCapacityError)
        return sendProblem(
          reply,
          'AUTHENTICATION_FAILED',
          400,
          'Authentication could not be completed.',
        );
      throw error;
    }
    setAuthCookie(reply, 'gestalt_mobile_login', token, deps.relyingParty.publicOrigin);
    return reply.send(options);
  });
}
