/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import { idempotencyKey } from '../../../platform/http/idempotency.js';
import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { canRestore } from './use-case.js';

export function registerRestoreSession(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    restore(session: RelaySessionSnapshot): Promise<RelaySessionSnapshot>;
    save(session: RelaySessionSnapshot): void;
    idempotency?: {
      get(scope: string, key: string): { statusCode: number; body: string } | null;
      put(scope: string, key: string, statusCode: number, body: string): void;
    };
  },
): void {
  app.post('/api/sessions/:id/restore', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const key = idempotencyKey(request.headers);
    const scope = `restore-session:${id}`;
    const prior = key ? deps.idempotency?.get(scope, key) : null;
    if (prior) return reply.code(prior.statusCode).send(JSON.parse(prior.body));
    const session = deps.find(id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    if (!canRestore(session)) return reply.code(409).send({ code: 'SESSION_CANNOT_RESTORE' });
    const restored = await deps.restore(session);
    deps.save(restored);
    if (key) deps.idempotency?.put(scope, key, 200, JSON.stringify(restored));
    return reply.send(restored);
  });
}
