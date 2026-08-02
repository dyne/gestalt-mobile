/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from 'fastify';
import type { AuthorizationRepository, Clock } from '../application/ports.js';
import { authorizationSessionId } from '../domain/identifiers.js';
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
    if (typeof token === 'string')
      deps.repository.revokeSession(authorizationSessionId(token), deps.clock.now().toISOString());
    reply.clearCookie('gestalt_mobile_session', {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: deps.relyingParty.publicOrigin.startsWith('https://'),
    });
    return reply.code(204).send();
  });
}
