/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { SupervisedPlan } from '../domain/supervised-plan.js';

export function registerGetPlan(
  app: FastifyInstance,
  deps: {
    exists(id: string): boolean;
    refresh(id: string): Promise<SupervisedPlan | null>;
  },
): void {
  app.get('/api/sessions/:id/plan', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!deps.exists(id)) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const plan = await deps.refresh(id);
    return plan ? reply.send(plan) : reply.code(204).send();
  });
}
