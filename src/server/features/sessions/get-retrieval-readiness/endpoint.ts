/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { SessionRetrievalReadiness } from '../../../../shared/contracts/retrieval-readiness.js';

export function registerGetRetrievalReadiness(
  app: FastifyInstance,
  deps: {
    exists(id: string): boolean;
    read(id: string): Promise<SessionRetrievalReadiness | null>;
  },
): void {
  app.get('/api/sessions/:id/retrieval-readiness', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!deps.exists(id)) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    reply.header('Cache-Control', 'no-store');
    try {
      return (await deps.read(id)) ?? { connections: [], repositories: [] };
    } catch {
      return reply.code(503).send({ code: 'RETRIEVAL_READINESS_UNAVAILABLE' });
    }
  });
}
