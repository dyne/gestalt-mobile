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
    let history: Awaited<ReturnType<typeof deps.read>>;
    try {
      history = await deps.read(session);
    } catch (error) {
      if (error instanceof Error && error.message === 'CODEX_SESSION_NOT_RUNNING')
        return reply.code(409).type('application/problem+json').send({
          type: 'urn:gestalt-mobile:error:session-history-unavailable',
          title: 'Session history unavailable',
          status: 409,
          detail:
            'GET /api/sessions/:id/history requires an active Codex session process. Open the session to restore it, then retry.',
          code: 'SESSION_HISTORY_UNAVAILABLE',
          retryable: true,
        });
      throw error;
    }
    const items: ChatItem[] = toChatItems(history.turns);
    return reply.send({
      items,
      activeTurnId: history.activeTurnId,
      currentSequence: deps.currentSequence(session.id),
    });
  });
}
