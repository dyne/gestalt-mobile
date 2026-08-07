/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { AuthorizationRepository } from '../../application/ports.js';
import { AuthorizationDomainError } from '../../domain/errors.js';
import { authorizedDeviceId } from '../../domain/identifiers.js';
import { problem } from '../../../../platform/http/problem.js';
import { renameAuthorizedDevice } from '../application.js';

const parameters = z.object({ deviceId: z.string().min(1).max(200) }).strict();
const requestBody = z.object({ nickname: z.string() }).strict();

export function registerRenameAuthorizedDevice(
  app: FastifyInstance,
  deps: { repository: AuthorizationRepository },
): void {
  app.patch('/api/auth/devices/:deviceId', async (request, reply) => {
    const params = parameters.safeParse(request.params);
    const body = requestBody.safeParse(request.body);
    if (!params.success || !body.success) return unavailable(reply, 400, 'INVALID_DEVICE_REQUEST');
    try {
      const outcome = renameAuthorizedDevice(
        deps.repository,
        authorizedDeviceId(params.data.deviceId),
        body.data.nickname,
      );
      if (outcome === 'renamed') return reply.code(204).send();
      return unavailable(reply, outcome === 'stale' ? 409 : 404, 'DEVICE_NOT_AVAILABLE');
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
