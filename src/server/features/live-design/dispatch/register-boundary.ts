/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { RelaySessionSnapshot } from '../../sessions/model/relay-session.js';
import { LiveDispatchError, type LiveDispatchPolicy } from '../application/dispatch.js';
import { problem } from '../../../platform/http/problem.js';

/** Registered after Mobile authentication; denies before endpoint idempotency or prompt storage. */
export function registerLiveDispatchBoundary(
  app: FastifyInstance,
  deps: {
    policy: LiveDispatchPolicy;
    session(id: string): RelaySessionSnapshot | null;
  },
): void {
  app.addHook('preHandler', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const route = request.routeOptions.url ?? '';
    if (!route.startsWith('/api/sessions/')) return;
    const id =
      (request.params as { id?: string; sessionId?: string; relayId?: string }).id ??
      (request.params as { sessionId?: string }).sessionId ??
      (request.params as { relayId?: string }).relayId;
    if (!id || route.includes('/live/') || route.endsWith('/interrupt')) return;
    if (route.endsWith('/autopilot') && (request.body as { enabled?: unknown })?.enabled === false)
      return;
    const session = deps.session(id);
    if (!session) return;
    try {
      // Claim synchronously before an endpoint can await discovery, persist a
      // model/control change or invoke a writer. Start cannot race that await.
      deps.policy.writer(session);
    } catch (error) {
      const code = error instanceof LiveDispatchError ? error.code : 'LIVE_STATE_UNAVAILABLE';
      return reply
        .code(code === 'LIVE_STATE_UNAVAILABLE' ? 503 : 409)
        .type('application/problem+json')
        .send(
          problem(
            code,
            code === 'LIVE_STATE_UNAVAILABLE' ? 503 : 409,
            'Stop or reconcile Live before sending.',
            true,
          ),
        );
    }
  });
}
