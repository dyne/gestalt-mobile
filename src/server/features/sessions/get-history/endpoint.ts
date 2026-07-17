/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { toChatItems, type ChatItem, type HistoryTurn } from './history-mapper.js';

export function registerGetHistory(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    read(session: RelaySessionSnapshot): Promise<{
      turns: HistoryTurn[];
      activeTurnId: string | null;
    }>;
    currentSequence(sessionId: string): number;
  },
): void {
  app.get('/api/sessions/:id/history', async (request, reply) => {
    const session = deps.find((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const history = await deps.read(session);
    const items: ChatItem[] = toChatItems(history.turns);
    return reply.send({
      items,
      activeTurnId: history.activeTurnId,
      currentSequence: deps.currentSequence(session.id),
    });
  });
}
