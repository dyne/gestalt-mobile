/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { WorkspacePlanReadResult } from '../domain/workspace-plan-catalog.js';

type OpenPlanResult = WorkspacePlanReadResult;

export function registerOpenPlan(
  app: FastifyInstance,
  deps: {
    exists(id: string): boolean;
    open(id: string, planName: string): Promise<OpenPlanResult>;
  },
): void {
  app.put('/api/sessions/:id/plan', async (request, reply) => {
    const sessionId = (request.params as { id: string }).id;
    if (!deps.exists(sessionId)) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const planName = (request.body as { planName?: unknown } | null)?.planName;
    if (typeof planName !== 'string' || planName.length === 0)
      return reply.code(400).send({ code: 'PLAN_NAME_REQUIRED' });

    try {
      const result = await deps.open(sessionId, planName);
      if (result.kind === 'available') return reply.send(result.plan);
      if (result.kind === 'source')
        return reply.send({
          kind: 'org-source',
          planName,
          title: result.title,
          source: result.source,
        });
      if (result.kind === 'missing') return reply.code(404).send({ code: 'PLAN_NOT_FOUND' });
      return reply.code(422).send({ code: 'PLAN_UNAVAILABLE' });
    } catch {
      return reply.code(503).send({ code: 'PLAN_OPEN_UNAVAILABLE' });
    }
  });
}
