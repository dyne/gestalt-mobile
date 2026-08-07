/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from 'fastify';
import type { AuthorizationRepository, Clock } from '../application/ports.js';
import { parseAuthorizationSessionId } from '../domain/identifiers.js';
import { clearAuthCookie } from '../http/cookies.js';
export function registerLogout(
  app: FastifyInstance,
  deps: {
    repository: AuthorizationRepository;
    clock: Clock;
    relyingParty: { publicOrigin: string };
  },
): void {
  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies.gestalt_mobile_session;
    const session = parseAuthorizationSessionId(token);
    if (session !== null) deps.repository.revokeSession(session, deps.clock.now().toISOString());
    clearAuthCookie(reply, 'gestalt_mobile_session', deps.relyingParty.publicOrigin);
    return reply.code(204).send();
  });
}
