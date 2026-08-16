/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { SafeInteractionOutcome } from '../../../../shared/contracts/chat-snapshot.js';

export type InteractionReplyResult = boolean | 'accepted' | 'cleared' | 'unavailable';

export function registerRespondInteraction(
  app: FastifyInstance,
  deps: {
    exists(sessionId: string): boolean;
    pending?(sessionId: string, requestId: string): boolean;
    validate?(sessionId: string, requestId: string, value: Record<string, unknown>): boolean;
    resolve(
      sessionId: string,
      requestId: string,
      resolvedAt: string,
      outcome: SafeInteractionOutcome,
    ): boolean;
    alreadyResolved?(
      sessionId: string,
      requestId: string,
    ): { resolvedAt: string; outcome: SafeInteractionOutcome } | null;
    reply(sessionId: string, requestId: string, value: unknown): InteractionReplyResult;
    resolved?(
      sessionId: string,
      requestId: string,
      occurredAt: string,
      outcome: SafeInteractionOutcome,
    ): void;
    now(): string;
  },
): void {
  app.post(
    '/api/sessions/:id/interactions/:requestId',
    { bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const { id, requestId } = request.params as { id: string; requestId: string };
      if (!deps.exists(id)) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
      const value = request.body;
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return reply.code(400).send({ code: 'INTERACTION_RESPONSE_INVALID' });
      const recorded = deps.alreadyResolved?.(id, requestId);
      if (recorded) return reply.code(202).send({ accepted: true, ...recorded });
      if (deps.pending && !deps.pending(id, requestId))
        return reply.code(409).send({ code: 'INTERACTION_NOT_PENDING' });
      if (deps.validate && !deps.validate(id, requestId, value as Record<string, unknown>))
        return reply.code(400).send({ code: 'INTERACTION_RESPONSE_INVALID' });
      const delivery = deps.reply(id, requestId, value);
      if (delivery === false || delivery === 'unavailable')
        return reply.code(409).send({ code: 'INTERACTION_DELIVERY_UNAVAILABLE' });
      if (delivery === 'cleared') {
        const resolvedAt = deps.now();
        const outcome = 'dismissed';
        if (deps.resolve(id, requestId, resolvedAt, outcome)) {
          deps.resolved?.(id, requestId, resolvedAt, outcome);
          return reply.code(202).send({ accepted: true, resolvedAt, outcome });
        }
        const raced = deps.alreadyResolved?.(id, requestId);
        return raced
          ? reply.code(202).send({ accepted: true, ...raced })
          : reply.code(409).send({ code: 'INTERACTION_NOT_PENDING' });
      }
      const resolvedAt = deps.now();
      const outcome = safeOutcome(value);
      if (!deps.resolve(id, requestId, resolvedAt, outcome))
        return reply.code(409).send({ code: 'INTERACTION_NOT_PENDING' });
      deps.resolved?.(id, requestId, resolvedAt, outcome);
      return reply.code(202).send({ accepted: true, resolvedAt, outcome });
    },
  );
}

function safeOutcome(value: unknown): SafeInteractionOutcome {
  if (typeof value !== 'object' || value === null) return 'answered';
  const decision = (value as { decision?: unknown }).decision;
  if (decision === 'approved' || decision === 'accept') return 'approved';
  if (decision === 'denied' || decision === 'decline') return 'denied';
  return 'answered';
}
