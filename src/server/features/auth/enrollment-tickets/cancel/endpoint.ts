/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AuthorizationRepository, Clock } from '../../application/ports.js';
import { parseAuthorizationSessionId } from '../../domain/identifiers.js';

const responseSchema = z.object({ status: z.enum(['none', 'used', 'expired']) }).strict();
export function registerCancelEnrollmentTicket(app: FastifyInstance, deps: { repository: AuthorizationRepository; clock: Clock }): void {
  app.delete('/api/auth/enrollment-tickets/current', async (request, reply) => {
    const rawSession = request.cookies.gestalt_mobile_session;
    const session = parseAuthorizationSessionId(rawSession);
    const now = deps.clock.now().toISOString();
    if (session === null || deps.repository.sessionDevice(session, now) === null)
      return reply.code(401).send();
    deps.repository.cancelEnrollmentTicket(session, now);
    return reply.send(responseSchema.parse({ status: deps.repository.enrollmentTicketStatus(session, now) }));
  });
}
