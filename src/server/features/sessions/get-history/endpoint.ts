/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type {
  ChatSnapshot,
  SafeInteractionSnapshot,
} from '../../../../shared/contracts/chat-snapshot.js';

import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { toChatItems, toChatTurns, type ChatItem, type HistoryTurn } from './history-mapper.js';

/**
 * ChatSnapshot is a lower-bound cut: baseSequence is sampled before the
 * upstream read, therefore every event with a higher sequence remains eligible
 * for ordered replay even when its effect is already visible in the snapshot.
 */

export function registerGetHistory(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    read(session: RelaySessionSnapshot): Promise<{
      turns: HistoryTurn[];
      activeTurnId: string | null;
    }>;
    currentSequence(sessionId: string): number;
    interactions?(sessionId: string): SafeInteractionSnapshot[];
  },
): void {
  app.get('/api/sessions/:id/history', async (request, reply) => {
    const session = deps.find((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const baseSequence = deps.currentSequence(session.id);
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
      return reply.code(502).type('application/problem+json').send({
        type: 'urn:gestalt-mobile:error:session-history-read-failed',
        title: 'Session history read failed',
        status: 502,
        detail:
          'GET /api/sessions/:id/history reached the relay, but Codex could not read this session history. The Codex process may have stopped during recovery; open the session again and inspect the running relay output if it persists.',
        code: 'SESSION_HISTORY_READ_FAILED',
        retryable: true,
      });
    }
    const items: ChatItem[] = toChatItems(history.turns);
    const snapshot: ChatSnapshot = {
      items,
      turns: toChatTurns(history.turns),
      activeTurnId: history.activeTurnId,
      interactions: deps.interactions?.(session.id) ?? [],
      baseSequence,
      // Temporary compatibility for clients which have not adopted ChatSnapshot.
      currentSequence: baseSequence,
    };
    return reply.send(snapshot);
  });
}
