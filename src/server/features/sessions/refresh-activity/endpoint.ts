/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from 'fastify';

/**
 * The client session controller owns foreground and sequence-gap detection.
 * On either signal it calls this idempotent boundary; replaying journal events
 * alone is deliberately not treated as an authoritative activity reconciliation.
 */
export function registerRefreshActivity(
  app: FastifyInstance,
  deps: { exists(id: string): boolean; refresh(id: string): Promise<void> },
): void {
  app.post('/api/sessions/:id/activity/refresh', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!deps.exists(id)) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    await deps.refresh(id);
    return reply.code(202).send({ accepted: true });
  });
}
