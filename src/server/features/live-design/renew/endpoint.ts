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
  limit,
  owner,
  sameAudience,
} from '../application/grants.js';
import { liveIdSchema, liveRunSchema, mobileRequest, parse } from '../http/boundary.js';

export function registerRenewLease(app: FastifyInstance, deps: PreviewGrantDependencies): void {
  app.post(
    '/api/sessions/:relayId/live/leases/:leaseId/renew',
    { bodyLimit: 4096 },
    async (request, reply) => {
      mobileRequest(request, deps.mobileOrigin);
      const { relayId, leaseId } = parse(
        z.strictObject({ relayId: liveIdSchema, leaseId: liveIdSchema }),
        request.params,
      );
      const body = parse(liveRunSchema, request.body);
      const audience = owner(deps, request.headers.cookie, relayId, body.liveId, body.generation);
      limit(deps, `owner:${audience.deviceId}`);
      const now = deps.now().toISOString();
      const lease = deps.store.renew(leaseId, (current) => {
        if (!sameAudience(current, audience)) return fail('LIVE_NOT_FOUND', 404);
        if (!leaseValid(deps, current, audience.previewOrigin, now))
          return fail('LIVE_LEASE_EXPIRED', 409);
        if (deps.now().getTime() - Date.parse(current.renewedAt ?? current.exchangedAt) < 60_000)
          return fail('LIVE_RATE_LIMITED', 429);
        return {
          ...current,
          renewedAt: now,
          leaseExpiresAt: new Date(
            Math.min(deps.now().getTime() + 300_000, Date.parse(current.absoluteExpiresAt)),
          ).toISOString(),
        };
      });
      if (!lease) return fail('LIVE_NOT_FOUND', 404);
      return reply.send(leaseDeadlines(lease));
    },
  );
}
