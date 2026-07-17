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
    validate?(sessionId: string, requestId: string, value: Record<string, unknown>): boolean;
    resolve(sessionId: string, requestId: string, resolvedAt: string): boolean;
    reply(sessionId: string, requestId: string, value: unknown): boolean;
    resolved?(sessionId: string, requestId: string, occurredAt: string): void;
    now(): string;
  },
): void {
  app.post('/api/sessions/:id/interactions/:requestId', async (request, reply) => {
    const { id, requestId } = request.params as { id: string; requestId: string };
    if (!deps.exists(id)) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const value = request.body;
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return reply.code(400).send({ code: 'INTERACTION_RESPONSE_INVALID' });
    if (deps.validate && !deps.validate(id, requestId, value as Record<string, unknown>))
      return reply.code(400).send({ code: 'INTERACTION_RESPONSE_INVALID' });
    if (!deps.reply(id, requestId, value))
      return reply.code(409).send({ code: 'INTERACTION_NOT_PENDING' });
    const resolvedAt = deps.now();
    if (!deps.resolve(id, requestId, resolvedAt))
      return reply.code(409).send({ code: 'INTERACTION_NOT_PENDING' });
    deps.resolved?.(id, requestId, resolvedAt);
    return reply.code(202).send({ accepted: true });
  });
}
