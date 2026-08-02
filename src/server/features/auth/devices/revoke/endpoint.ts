/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { AuthorizationRepository, Clock } from '../../application/ports.js';
import { AuthorizationDomainError } from '../../domain/errors.js';
import { authorizedDeviceId } from '../../domain/identifiers.js';
import { problem } from '../../../../platform/http/problem.js';
import { authorizationSessionDevice } from '../../../../platform/http/authorization-boundary.js';
import { revokeAuthorizedDevice } from '../application.js';

const parameters = z.object({ deviceId: z.string().min(1).max(200) }).strict();

export function registerRevokeAuthorizedDevice(
  app: FastifyInstance,
  deps: { repository: AuthorizationRepository; clock: Clock; relyingParty: { publicOrigin: string } },
): void {
  app.delete('/api/auth/devices/:deviceId', async (request, reply) => {
    const params = parameters.safeParse(request.params);
    if (!params.success) return unavailable(reply, 400, 'INVALID_DEVICE_REQUEST');
    try {
      const id = authorizedDeviceId(params.data.deviceId);
      const current = authorizationSessionDevice(request.headers.cookie, deps);
      const outcome = revokeAuthorizedDevice(deps.repository, id, deps.clock.now().toISOString());
      if (outcome === 'finalDevice')
        return reply
          .code(409)
          .type('application/problem+json')
          .send(problem('LAST_DEVICE_REQUIRED', 409, 'At least one authorized device is required.'));
      if (outcome === 'notFound') return unavailable(reply, 404, 'DEVICE_NOT_AVAILABLE');
      if (current === id)
        reply.clearCookie('gestalt_mobile_session', {
          path: '/', httpOnly: true, sameSite: 'strict',
          secure: deps.relyingParty.publicOrigin.startsWith('https://'),
        });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof AuthorizationDomainError)
        return unavailable(reply, 400, 'INVALID_DEVICE_REQUEST');
      throw error;
    }
  });
}

function unavailable(reply: FastifyReply, status: number, code: string) {
  return reply
    .code(status)
    .type('application/problem+json')
    .send(problem(code, status, 'The requested device is not available.'));
}
