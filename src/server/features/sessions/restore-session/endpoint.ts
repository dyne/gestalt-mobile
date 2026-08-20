/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import { idempotencyKey } from '../../../platform/http/idempotency.js';
import { RelaySession, relayOwnsWriter } from '../model/relay-session.js';
import type { RestoreSessionResult } from '../../../platform/codex/session-runtime.js';
import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { canRestore } from './use-case.js';

export function registerRestoreSession(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    restore(session: RelaySessionSnapshot): Promise<RestoreSessionResult | RelaySessionSnapshot>;
    save(session: RelaySessionSnapshot): void;
    ownsWriter?(id: string): boolean;
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
    // Opening an already live session is a safe no-op. It must not tear down or
    // replace this relay's writer merely because a client retried Open while the
    // session was becoming ready.
    const staleWriter = relayOwnsWriter(session) && deps.ownsWriter?.(id) === false;
    if (!canRestore(session) && !staleWriter) {
      if (relayOwnsWriter(session)) return reply.send(session);
      return reply.code(409).send({ code: 'SESSION_CANNOT_RESTORE' });
    }
    const recovering = RelaySession.rehydrate(session).beginRecovery(
      new Date().toISOString(),
    ).snapshot;
    deps.save(recovering);
    let restored: RestoreSessionResult | RelaySessionSnapshot;
    try {
      restored = await deps.restore(session);
    } catch {
      // The pre-I/O recovery marker must never strand a saved session: keep
      // its original thread and inactive state available for a later Open.
      deps.save(
        staleWriter
          ? RelaySession.rehydrate(session).stop(new Date().toISOString()).snapshot
          : session,
      );
      return reply.code(502).send({ code: 'RESTORE_FAILED' });
    }
    const response =
      'session' in restored
        ? {
            ...restored.session,
            ...(restored.replacementCreated
              ? { recovery: { historyUnavailable: true, replacementCreated: true } }
              : {}),
          }
        : restored;
    deps.save(response);
    const settled =
      (response.state === 'ready' || response.state === 'turnActive') &&
      deps.ownsWriter &&
      !deps.ownsWriter(id)
        ? RelaySession.rehydrate(response).stop(new Date().toISOString()).snapshot
        : response;
    if (settled !== response) deps.save(settled);
    if (key) deps.idempotency?.put(scope, key, 200, JSON.stringify(settled));
    return reply.send(settled);
  });
}
