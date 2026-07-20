/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import { idempotencyKey } from '../../../platform/http/idempotency.js';
import type { RelaySessionSnapshot } from '../model/relay-session.js';

export function registerReleaseSession(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    release(session: RelaySessionSnapshot): RelaySessionSnapshot;
    save(session: RelaySessionSnapshot): void;
    close(id: string): void | Promise<void>;
    idempotency?: {
      get(scope: string, key: string): { statusCode: number; body: string } | null;
      put(scope: string, key: string, statusCode: number, body: string): void;
    };
  },
): void {
  app.post('/api/sessions/:id/release', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const key = idempotencyKey(request.headers);
    const scope = `release-session:${id}`;
    const prior = key ? deps.idempotency?.get(scope, key) : null;
    if (prior) return reply.code(prior.statusCode).send(JSON.parse(prior.body));
    const session = deps.find(id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const released = deps.release(session);
    deps.save(released);
    await deps.close(id);
    if (key) deps.idempotency?.put(scope, key, 202, JSON.stringify(released));
    return reply.code(202).send(released);
  });
}
