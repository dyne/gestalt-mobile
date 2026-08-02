/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { AuthorizationRepository, Clock } from '../../application/ports.js';
import { authorizationSessionDevice } from '../../../../platform/http/authorization-boundary.js';
import { listAuthorizedDeviceMetadata } from '../application.js';

export function registerListAuthorizedDevices(
  app: FastifyInstance,
  deps: { repository: AuthorizationRepository; clock: Clock },
): void {
  app.get('/api/auth/devices', async (request) => ({
    devices: listAuthorizedDeviceMetadata(
      deps.repository,
      authorizationSessionDevice(request.headers.cookie, deps),
    ),
  }));
}
