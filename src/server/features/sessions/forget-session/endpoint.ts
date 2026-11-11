/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { RelaySessionSnapshot } from '../model/relay-session.js';
import type { SessionForgetOperation } from '../../../../shared/contracts/session-forget.js';

export function registerForgetSession(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    close?(id: string): void | Promise<void>;
    remove?(id: string): void;
    forget?(id: string): Promise<SessionForgetOperation | null>;
  },
): void {
  app.delete('/api/sessions/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (deps.forget) {
      const operation = await deps.forget(id);
      if (!operation) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
      if (operation.phase === 'failed' && operation.blockingSessionId)
        return reply.code(409).send({
          code: 'SESSION_NESTED_WORKSPACE',
          sessionId: operation.blockingSessionId,
          detail: 'Forget the contained workspace session first, then retry.',
          operation,
        });
      if (operation.phase !== 'completed')
        return reply.code(503).send({ code: 'SESSION_FORGET_FAILED', operation });
      return reply.code(204).send();
    }
    if (!deps.find(id)) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    await deps.close?.(id);
    deps.remove?.(id);
    return reply.code(204).send();
  });
}
