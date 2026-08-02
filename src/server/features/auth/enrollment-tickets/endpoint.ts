/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from 'fastify';
import type { AuthorizationRepository, Clock, RandomBytes } from '../application/ports.js';
import { authorizationSessionId, enrollmentTicketId } from '../domain/identifiers.js';

const lifetimeMs = 10 * 60 * 1000;
export function registerCreateEnrollmentTicket(app: FastifyInstance, deps: { repository: AuthorizationRepository; clock: Clock; random: RandomBytes; relyingParty: { publicOrigin: string } }): void {
  app.post('/api/auth/enrollment-tickets', async (request, reply) => {
    const rawSession = request.cookies.gestalt_mobile_session;
    if (typeof rawSession !== 'string' || deps.repository.sessionDevice(authorizationSessionId(rawSession), deps.clock.now().toISOString()) === null)
      return reply.code(401).send();
    const entropy = deps.random.bytes(32);
    if (entropy.length < 32) throw new Error('AUTHORIZATION_RANDOMNESS_INVALID');
    const ticket = enrollmentTicketId(Buffer.from(entropy).toString('base64url'));
    const expiresAt = new Date(deps.clock.now().getTime() + lifetimeMs).toISOString();
    deps.repository.issueEnrollmentTicket(ticket, authorizationSessionId(rawSession), expiresAt);
    return reply.code(201).send({ ticket, url: `${deps.relyingParty.publicOrigin.replace(/\/$/, '')}/#enroll=${ticket}`, expiresAt });
  });
}
