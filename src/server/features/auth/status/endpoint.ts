/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from 'fastify';
import type { AuthorizationRepository, Clock } from '../application/ports.js';
import { authorizationSessionId } from '../domain/identifiers.js';
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
    const authenticated =
      typeof token === 'string' &&
      deps.repository.sessionDevice(
        authorizationSessionId(token),
        deps.clock.now().toISOString(),
      ) !== null;
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
