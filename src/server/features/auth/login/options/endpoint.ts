/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { problem } from '../../../../platform/http/problem.js';
import type {
  AuthorizationRepository,
  Clock,
  RandomBytes,
  WebAuthnCeremonyService,
} from '../../application/ports.js';
import { passkeyCeremonyId } from '../../domain/identifiers.js';

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
  },
): void {
  app.post('/api/auth/login/options', async (_request, reply) => {
    if (deps.repository.listAuthorizedDevices().length === 0)
      return reply
        .code(400)
        .type('application/problem+json')
        .send(problem('AUTHENTICATION_FAILED', 400, 'Authentication could not be completed.'));
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
    deps.repository.saveCeremony(token, {
      purpose: 'authentication',
      challenge,
      expectedOrigin: deps.relyingParty.publicOrigin,
      rpId: deps.relyingParty.rpId,
      expiresAt: new Date(now.getTime() + lifetimeMs).toISOString(),
    });
    reply.setCookie('gestalt_mobile_login', token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: deps.relyingParty.publicOrigin.startsWith('https://'),
      maxAge: 600,
    });
    return reply.send(options);
  });
}
