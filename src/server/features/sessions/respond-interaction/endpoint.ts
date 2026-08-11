/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

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
      outcome: 'approved' | 'denied' | 'answered',
    ): boolean;
    alreadyResolved?(
      sessionId: string,
      requestId: string,
    ): { resolvedAt: string; outcome: 'approved' | 'denied' | 'answered' } | null;
    reply(sessionId: string, requestId: string, value: unknown): boolean;
    resolved?(
      sessionId: string,
      requestId: string,
      occurredAt: string,
      outcome: 'approved' | 'denied' | 'answered',
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
      if (!deps.reply(id, requestId, value))
        return reply.code(409).send({ code: 'INTERACTION_NOT_PENDING' });
      const resolvedAt = deps.now();
      const outcome = safeOutcome(value);
      if (!deps.resolve(id, requestId, resolvedAt, outcome))
        return reply.code(409).send({ code: 'INTERACTION_NOT_PENDING' });
      deps.resolved?.(id, requestId, resolvedAt, outcome);
      return reply.code(202).send({ accepted: true, resolvedAt, outcome });
    },
  );
}

function safeOutcome(value: unknown): 'approved' | 'denied' | 'answered' {
  if (typeof value !== 'object' || value === null) return 'answered';
  const decision = (value as { decision?: unknown }).decision;
  if (decision === 'approved' || decision === 'accept') return 'approved';
  if (decision === 'denied' || decision === 'decline') return 'denied';
  return 'answered';
}
