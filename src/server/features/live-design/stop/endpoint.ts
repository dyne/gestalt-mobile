/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PreviewGrantDependencies } from '../application/ports.js';
import { fail, limit, LiveAuthError } from '../application/grants.js';
import { liveIdSchema, liveRunSchema, mobileRequest, parse } from '../http/boundary.js';

/** Authenticated owning-session generation only; all runtime authority stays private. */
export function registerLiveStop(app: FastifyInstance, deps: PreviewGrantDependencies): void {
  const execute = deps.control?.stop;
  if (!execute) return;
  app.post('/api/sessions/:relayId/live/stop', { bodyLimit: 4096 }, async (request, reply) => {
    mobileRequest(request, deps.mobileOrigin);
    const { relayId } = parse(z.strictObject({ relayId: liveIdSchema }), request.params);
    const input = parse(liveRunSchema, request.body);
    const now = deps.now().toISOString();
    const identity = deps.authentication.identity(request.headers.cookie, now);
    if (
      !identity ||
      !deps.authentication.authorized(identity.authSessionHash, identity.deviceId, now)
    )
      return fail('LIVE_AUTH_REQUIRED', 401);
    limit(deps, `stop:${identity.deviceId}`);
    try {
      const run = await execute.call(deps.control, { relayId, ...input, ...identity });
      return reply.code(200).send({
        state: run.state,
        liveId: run.liveId,
        generation: run.generation,
        previewOrigin: run.previewOrigin,
      });
    } catch (error) {
      if (error instanceof LiveAuthError) throw error;
      const code = (error as Error)?.message;
      if (['LIVE_GENERATION_STALE', 'LIVE_STATE_CONFLICT'].includes(code))
        throw new LiveAuthError(code, 409);
      if (code === 'LIVE_AUTH_UNAVAILABLE') throw new LiveAuthError(code, 403);
      throw new LiveAuthError('LIVE_STOP_RECOVERY_REQUIRED', 503);
    }
  });
}
