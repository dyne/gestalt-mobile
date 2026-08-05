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
import { parseEnrollmentTicketId, passkeyCeremonyId } from '../../domain/identifiers.js';
import { CeremonyCapacityError } from '../../domain/errors.js';
import { setAuthCookie } from '../../http/cookies.js';
import type { CeremonyAttemptGate } from '../../application/ceremony-attempts.js';

const requestSchema = z.object({ enrollmentTicket: z.string().min(1).optional() }).strict();
const optionsResponseSchema = z
  .object({ options: z.object({ challenge: z.string().min(1) }).passthrough() })
  .strict();
const lifetimeMs = 10 * 60 * 1000;

export function registerRegistrationOptions(
  app: FastifyInstance,
  deps: {
    repository: AuthorizationRepository;
    clock: Clock;
    random: RandomBytes;
    webauthn: WebAuthnCeremonyService;
    relyingParty: { publicOrigin: string; rpId: string; rpName: string };
    ceremonyAttempts: CeremonyAttemptGate;
  },
): void {
  app.post('/api/auth/register/options', { bodyLimit: 4 * 1024 }, async (request, reply) => {
    if (!deps.ceremonyAttempts.allow(`register:${request.ip}`, deps.clock.now()))
      return reply
        .code(400)
        .type('application/problem+json')
        .send(problem('REGISTRATION_NOT_AVAILABLE', 400, 'Registration could not be completed.'));
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .type('application/problem+json')
        .send(problem('INVALID_REGISTRATION_REQUEST', 400, 'The registration request is invalid.'));
    const ticket =
      parsed.data.enrollmentTicket === undefined
        ? undefined
        : parseEnrollmentTicketId(parsed.data.enrollmentTicket);
    if (ticket === null)
      return reply
        .code(400)
        .type('application/problem+json')
        .send(problem('INVALID_REGISTRATION_REQUEST', 400, 'The registration request is invalid.'));
    const owner = deps.repository.readOwner();
    const devices = deps.repository.listAuthorizedDevices();
    const now = deps.clock.now();
    if (
      devices.length > 0 &&
      (!ticket || !deps.repository.ticketAvailable(ticket, now.toISOString()))
    )
      return reply
        .code(403)
        .type('application/problem+json')
        .send(problem('ENROLLMENT_NOT_AUTHORIZED', 403, 'Registration is not authorized.'));
    const ownerHandle = owner ? undefined : deps.random.bytes(32);
    if (ownerHandle && ownerHandle.length !== 32)
      throw new Error('AUTHORIZATION_RANDOMNESS_INVALID');
    const initialized = owner ?? deps.repository.initializeOwner(ownerHandle!);
    const correlation = deps.random.bytes(32);
    const challenge = deps.random.bytes(32);
    if (correlation.length !== 32 || challenge.length !== 32)
      throw new Error('AUTHORIZATION_RANDOMNESS_INVALID');
    const token = passkeyCeremonyId(Buffer.from(correlation).toString('base64url'));
    const options = optionsResponseSchema.parse({
      options: await deps.webauthn.registrationOptions({
        challenge,
        rpId: deps.relyingParty.rpId,
        userVerification: 'required',
        rpName: deps.relyingParty.rpName,
        userHandle: initialized.userHandle,
        excludeCredentialIds: devices.map((device) => device.credentialId),
      }),
    });
    try {
      deps.repository.saveCeremony(
        token,
        {
          purpose: 'registration',
          challenge,
          expectedOrigin: deps.relyingParty.publicOrigin,
          rpId: deps.relyingParty.rpId,
          expiresAt: new Date(now.getTime() + lifetimeMs).toISOString(),
          ...(ticket ? { enrollmentTicket: ticket } : {}),
        },
        now.toISOString(),
      );
    } catch (error) {
      if (error instanceof CeremonyCapacityError)
        return reply
          .code(400)
          .type('application/problem+json')
          .send(problem('REGISTRATION_NOT_AVAILABLE', 400, 'Registration could not be completed.'));
      throw error;
    }
    setAuthCookie(reply, 'gestalt_mobile_registration', token, deps.relyingParty.publicOrigin);
    return reply.send(options);
  });
}
