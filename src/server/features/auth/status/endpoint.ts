/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from 'fastify';
import type { AuthorizationRepository, Clock } from '../application/ports.js';
import { parseAuthorizationSessionId } from '../domain/identifiers.js';
export function registerAuthStatus(
  app: FastifyInstance,
  deps: {
    repository: AuthorizationRepository;
    clock: Clock;
    relyingParty: { publicOrigin: string };
  },
): void {
  app.get('/api/auth/status', async (request) => {
    const token = request.cookies.gestalt_mobile_session;
    const session = parseAuthorizationSessionId(token);
    const authenticated =
      session !== null &&
      deps.repository.sessionDevice(session, deps.clock.now().toISOString()) !== null;
    return {
      status: authenticated
        ? 'authenticated'
        : deps.repository.listAuthorizedDevices().length
          ? 'locked'
          : 'bootstrap',
      publicOrigin: deps.relyingParty.publicOrigin,
    };
  });
}
