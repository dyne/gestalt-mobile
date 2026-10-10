/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PreviewGrantDependencies } from '../application/ports.js';
import {
  currentAudience,
  fail,
  leaseDeadlines,
  leaseValid,
  limit,
  previewOrigin,
} from '../application/grants.js';
import {
  deliverPreviewCookie,
  liveIdSchema,
  liveTokenSchema,
  parse,
  previewCookieName,
  previewRequest,
  registerLiveHttpBoundary,
} from '../http/boundary.js';

const exchangeSchema = z.strictObject({
  grantId: liveIdSchema,
  grant: liveTokenSchema,
  codeVerifier: liveTokenSchema,
});

export type PreviewExchangeDependencies = PreviewGrantDependencies & {
  /** Supplied by the trusted origin/port allocation, never a request header. */
  boundOrigin: string;
  document: { html: string; csp: string };
};
export function registerPreviewExchange(
  app: FastifyInstance,
  deps: PreviewExchangeDependencies,
): void {
  const origin = previewOrigin(deps.boundOrigin, deps.mobileOrigin);
  if (origin !== deps.boundOrigin) throw new Error('Preview listener origin must be canonical');
  app.register(async (scope) => {
    registerLiveHttpBoundary(scope);
    scope.get('/__gestalt_live/auth', async (request, reply) => {
      previewRequest(request, origin, false);
      return reply
        .header('Content-Security-Policy', deps.document.csp)
        .header('Cross-Origin-Opener-Policy', 'unsafe-none')
        .header('X-Content-Type-Options', 'nosniff')
        .header('X-Frame-Options', 'DENY')
        .type('text/html')
        .send(deps.document.html);
    });
    scope.post('/__gestalt_live/exchange', { bodyLimit: 4096 }, async (request, reply) => {
      previewRequest(request, origin, true);
      limit(deps, `peer:${deps.secrets.hash(request.ip)}`);
      const body = parse(exchangeSchema, request.body);
      const now = deps.now().toISOString();
      let token: string | null = null;
      const lease = deps.store.exchange(body.grantId, (grant) => {
        limit(deps, `owner:${grant.deviceId}`);
        if (
          grant.previewOrigin !== origin ||
          now >= grant.expiresAt ||
          !deps.secrets.equal(grant.tokenHash, deps.secrets.hash(body.grant)) ||
          !deps.secrets.equal(grant.codeChallenge, deps.secrets.challenge(body.codeVerifier)) ||
          !currentAudience(deps, grant, now)
        )
          return null;
        token = deps.secrets.token();
        return {
          relayId: grant.relayId,
          appId: grant.appId,
          liveId: grant.liveId,
          generation: grant.generation,
          previewOrigin: grant.previewOrigin,
          authSessionHash: grant.authSessionHash,
          deviceId: grant.deviceId,
          leaseId: deps.secrets.id(),
          tokenHash: deps.secrets.hash(token),
          exchangedAt: now,
          leaseExpiresAt: new Date(deps.now().getTime() + 300_000).toISOString(),
          absoluteExpiresAt: new Date(deps.now().getTime() + 3_600_000).toISOString(),
          renewedAt: null,
        };
      });
      if (!lease || !token) return fail('LIVE_GRANT_INVALID', 401);
      deliverPreviewCookie(reply, origin, token, 300);
      return reply
        .code(201)
        .send({ liveId: lease.liveId, generation: lease.generation, ...leaseDeadlines(lease) });
    });
    scope.post('/__gestalt_live/lease', { bodyLimit: 4096 }, async (request, reply) => {
      previewRequest(request, origin, true);
      parse(z.strictObject({}), request.body);
      const name = previewCookieName(origin);
      const cookies = (request.headers.cookie ?? '')
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.startsWith(`${name}=`));
      const token = cookies.length === 1 ? cookies[0]!.slice(name.length + 1) : undefined;
      if (!token || !liveTokenSchema.safeParse(token).success)
        return fail('LIVE_AUTH_REQUIRED', 401);
      const lease = deps.store.findLease(deps.secrets.hash(token));
      const now = deps.now();
      if (!lease || !leaseValid(deps, lease, origin, now.toISOString()))
        return fail('LIVE_AUTH_REQUIRED', 401);
      const seconds = Math.floor((Date.parse(lease.leaseExpiresAt) - now.getTime()) / 1000);
      deliverPreviewCookie(reply, origin, token, seconds);
      return reply.send(leaseDeadlines(lease));
    });
  });
}
