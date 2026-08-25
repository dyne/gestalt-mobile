/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { queueTurnInput } from './use-case.js';

export function registerQueueTurnInput(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    queue(
      session: RelaySessionSnapshot,
      turnId: string,
      text: string,
      clientUserMessageId?: string,
    ): Promise<void>;
  },
): void {
  app.post(
    '/api/sessions/:id/turns/:turnId/queue',
    { bodyLimit: 128 * 1024 },
    async (request, reply) => {
      const { id, turnId } = request.params as { id: string; turnId: string };
      const session = deps.find(id);
      if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
      const text = (request.body as { text?: string }).text?.trim() ?? '';
      if (text.length > 100_000) return reply.code(400).send({ code: 'TURN_INPUT_TOO_LONG' });
      if (!text) return reply.code(409).send({ code: 'TURN_INPUT_EMPTY' });
      const result = queueTurnInput(session, turnId);
      if (!result.accepted) return reply.code(409).send({ code: result.code });
      const key = request.headers['idempotency-key'];
      await deps.queue(session, turnId, text, typeof key === 'string' ? key : undefined);
      return reply.code(202).send({ accepted: true, activeTurnId: turnId });
    },
  );
}
