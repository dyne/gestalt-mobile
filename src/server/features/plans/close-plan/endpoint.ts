/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { problem } from '../../../platform/http/problem.js';
import type { SupervisedPlan } from '../domain/supervised-plan.js';

export function registerClosePlan(
  app: FastifyInstance,
  deps: {
    exists(id: string): boolean;
    find(id: string): SupervisedPlan | null;
    removeStatus(id: string): Promise<void>;
    clear(id: string): void;
    closed(id: string): void;
  },
): void {
  app.delete('/api/sessions/:id/plan', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!deps.exists(id)) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const plan = deps.find(id);
    if (!plan) return reply.code(204).send();
    if (!plan.allDone)
      return reply
        .code(409)
        .type('application/problem+json')
        .send(problem('PLAN_INCOMPLETE', 409, 'Only completed supervised plans can be closed.'));
    try {
      await deps.removeStatus(id);
    } catch {
      return reply
        .code(503)
        .type('application/problem+json')
        .send(
          problem(
            'PLAN_CLOSE_UNAVAILABLE',
            503,
            'The relay could not close the supervised plan.',
            true,
          ),
        );
    }
    deps.clear(id);
    deps.closed(id);
    return reply.code(204).send();
  });
}
