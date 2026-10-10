/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PreviewGrantDependencies } from '../application/ports.js';
import { leaseDeadlines, leaseValid, owner, sameAudience } from '../application/grants.js';
import { liveIdSchema, parse } from '../http/boundary.js';

export function registerLiveGrantStatus(
  app: FastifyInstance,
  deps: PreviewGrantDependencies,
): void {
  app.get('/api/sessions/:relayId/live', async (request) => {
    const { relayId } = parse(z.strictObject({ relayId: liveIdSchema }), request.params);
    const audience = owner(deps, request.headers.cookie, relayId);
    const now = deps.now().toISOString();
    return {
      liveId: audience.liveId,
      generation: audience.generation,
      leases: deps.store
        .listLeases(audience.authSessionHash, relayId)
        .filter(
          (lease) =>
            sameAudience(lease, audience) && leaseValid(deps, lease, audience.previewOrigin, now),
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
