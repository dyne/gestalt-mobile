/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PreviewGrantDependencies } from '../application/ports.js';
import { fail, limit, owner } from '../application/grants.js';
import {
  liveIdSchema,
  liveRunSchema,
  liveTokenSchema,
  mobileRequest,
  parse,
} from '../http/boundary.js';

const requestSchema = liveRunSchema.extend({
  codeChallenge: liveTokenSchema,
  codeChallengeMethod: z.literal('S256'),
});
export function registerLaunchGrant(app: FastifyInstance, deps: PreviewGrantDependencies): void {
  app.post(
    '/api/sessions/:relayId/live/launch-grants',
    { bodyLimit: 4096 },
    async (request, reply) => {
      mobileRequest(request, deps.mobileOrigin);
      const { relayId } = parse(z.strictObject({ relayId: liveIdSchema }), request.params);
      const body = parse(requestSchema, request.body);
      const audience = owner(deps, request.headers.cookie, relayId, body.liveId, body.generation);
      limit(deps, `owner:${audience.deviceId}`);
      const grant = deps.secrets.token();
      const grantId = deps.secrets.id();
      const expiresAt = new Date(deps.now().getTime() + 60_000).toISOString();
      const saved = deps.store.saveGrant({
        ...audience,
        grantId,
        tokenHash: deps.secrets.hash(grant),
        codeChallenge: body.codeChallenge,
        expiresAt,
      });
      if (!saved) return fail('LIVE_NOT_ACTIVE', 409);
      const exchangeUrl = `${audience.previewOrigin}/__gestalt_live/auth#grant=${grant}&grantId=${grantId}`;
      return reply
        .code(201)
        .send({ grantId, grant, previewOrigin: audience.previewOrigin, exchangeUrl, expiresAt });
    },
  );
}
