/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PreviewGrantDependencies } from '../application/ports.js';
import { fail, limit, LiveAuthError } from '../application/grants.js';
import { liveIdSchema, mobileRequest, parse } from '../http/boundary.js';

const body = z.strictObject({
  appId: liveIdSchema,
  targetId: liveIdSchema,
  operationId: liveIdSchema,
});
const publicFailures = new Set([
  'LIVE_SESSION_BUSY',
  'LIVE_MODE_ACTIVE',
  'LIVE_APP_BUSY',
  'LIVE_PROVIDER_UNSUPPORTED',
  'LIVE_TARGET_UNREGISTERED',
  'LIVE_SESSION_UNAVAILABLE',
  'LIVE_DEPENDENCIES_UNAVAILABLE',
  'LIVE_UNAPPROVED_LAUNCH_SURFACE',
  'LIVE_OWNING_POLICY_UNVERIFIED',
  'LIVE_CONFIG_CHANGED',
  'LIVE_CLEANUP_REQUIRED',
]);

/** Authenticated owning-session IDs only. No launch/configuration/receipt inputs. */
export function registerLiveStart(app: FastifyInstance, deps: PreviewGrantDependencies): void {
  if (!deps.control) return;
  app.get('/api/sessions/:relayId/live/targets', async (request) => {
    const { relayId } = parse(z.strictObject({ relayId: liveIdSchema }), request.params);
    const now = deps.now().toISOString();
    const identity = deps.authentication.identity(request.headers.cookie, now);
    if (
      !identity ||
      !deps.authentication.authorized(identity.authSessionHash, identity.deviceId, now)
    )
      return fail('LIVE_AUTH_REQUIRED', 401);
    return { targets: deps.control!.targetsForRelay(relayId) };
  });
  app.post('/api/sessions/:relayId/live/start', { bodyLimit: 4096 }, async (request, reply) => {
    mobileRequest(request, deps.mobileOrigin);
    const { relayId } = parse(z.strictObject({ relayId: liveIdSchema }), request.params);
    const input = parse(body, request.body);
    const now = deps.now().toISOString();
    const identity = deps.authentication.identity(request.headers.cookie, now);
    if (
      !identity ||
      !deps.authentication.authorized(identity.authSessionHash, identity.deviceId, now)
    )
      return fail('LIVE_AUTH_REQUIRED', 401);
    limit(deps, `start:${identity.deviceId}`);
    try {
      const run = await deps.control!.start({ relayId, ...input, ...identity });
      return reply.code(200).send({
        state: run.state,
        liveId: run.liveId,
        generation: run.generation,
        previewOrigin: run.previewOrigin,
      });
    } catch (error) {
      if (error instanceof LiveAuthError) throw error;
      const code = publicFailures.has((error as Error)?.message)
        ? (error as Error).message
        : 'LIVE_START_FAILED';
      throw new LiveAuthError(
        code,
        ['LIVE_SESSION_BUSY', 'LIVE_MODE_ACTIVE', 'LIVE_APP_BUSY'].includes(code) ? 409 : 503,
      );
    }
  });
}
