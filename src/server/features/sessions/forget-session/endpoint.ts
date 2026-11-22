/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { RelaySessionSnapshot } from '../model/relay-session.js';
import type { SessionForgetOperation } from '../../../../shared/contracts/session-forget.js';

import { ForgetRecoveryUnavailable } from './use-case.js';

export const keepTemporaryFilesRoute = '/api/sessions/:id/keep-temporary-files/:keepFilesFor';

export function registerForgetSession(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    close?(id: string): void | Promise<void>;
    remove?(id: string): void;
    forget?(id: string, keepFilesFor?: string): Promise<SessionForgetOperation | null>;
  },
): void {
  const remove = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, keepFilesFor } = request.params as { id: string; keepFilesFor?: string };
    if (deps.forget) {
      let operation;
      try {
        operation = await deps.forget(id, keepFilesFor);
      } catch (error) {
        if (error instanceof ForgetRecoveryUnavailable)
          return reply.code(409).send({ code: 'SESSION_FORGET_RECOVERY_UNAVAILABLE' });
        throw error;
      }
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
  };
  app.delete('/api/sessions/:id', remove);
  if (deps.forget) app.delete(keepTemporaryFilesRoute, remove);
}
