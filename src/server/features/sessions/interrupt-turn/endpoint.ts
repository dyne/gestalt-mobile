/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { interruptTurn } from './use-case.js';

export function registerInterruptTurn(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    interrupt(session: RelaySessionSnapshot, turnId: string): Promise<void>;
  },
): void {
  app.post('/api/sessions/:id/turns/:turnId/interrupt', async (request, reply) => {
    const { id, turnId } = request.params as { id: string; turnId: string };
    const session = deps.find(id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const result = interruptTurn(session, turnId);
    if (!result.accepted) return reply.code(409).send({ code: result.code });
    await deps.interrupt(session, turnId);
    return reply.send({ accepted: true });
  });
}
