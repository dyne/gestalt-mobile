/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PreviewGrantDependencies } from '../application/ports.js';
import {
  fail,
  leaseDeadlines,
  leaseValid,
  previewOrigin,
  sameAudience,
} from '../application/grants.js';
import { liveIdSchema, parse } from '../http/boundary.js';

export function registerLiveGrantStatus(
  app: FastifyInstance,
  deps: PreviewGrantDependencies,
): void {
  app.get('/api/sessions/:relayId/live', async (request) => {
    const { relayId } = parse(z.strictObject({ relayId: liveIdSchema }), request.params);
    const now = deps.now().toISOString();
    const identity = deps.authentication.identity(request.headers.cookie, now);
    if (
      !identity ||
      !deps.authentication.authorized(identity.authSessionHash, identity.deviceId, now)
    )
      return fail('AUTH_REQUIRED', 401);
    const audience = deps.owners.read(relayId);
    if (
      !audience ||
      audience.authSessionHash !== identity.authSessionHash ||
      audience.deviceId !== identity.deviceId
    )
      return fail('LIVE_NOT_FOUND', 404);
    previewOrigin(audience.previewOrigin, deps.mobileOrigin);
    return {
      liveId: audience.liveId,
      generation: audience.generation,
      ...(audience.state ? { state: audience.state } : {}),
      leases: deps.store
        .listLeases(audience.authSessionHash, relayId)
        .filter(
          (lease) =>
            audience.active &&
            sameAudience(lease, audience) &&
            leaseValid(deps, lease, audience.previewOrigin, now),
        )
        .map((lease) => ({
          leaseId: lease.leaseId,
          liveId: lease.liveId,
          generation: lease.generation,
          ...leaseDeadlines(lease),
        })),
    };
  });
}
