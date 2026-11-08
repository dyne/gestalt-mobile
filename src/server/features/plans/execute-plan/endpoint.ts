/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import {
  orgPlanLaunchRequestSchema,
  type OrgPlanLaunchRequest,
  type OrgPlanLaunchResult,
} from '../../../../shared/contracts/org-plan-execution.js';

export type ExecuteOrgPlanRoutes = {
  startOrgPlanSupervision(request: OrgPlanLaunchRequest): Promise<OrgPlanLaunchResult>;
};

export function registerExecuteOrgPlan(app: FastifyInstance, deps: ExecuteOrgPlanRoutes): void {
  app.post('/api/plans/execute', async (request, reply) => {
    const parsed = orgPlanLaunchRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        kind: 'rejected',
        code: 'INVALID_LAUNCH_REQUEST',
        reason: 'Confirm a valid plan and launch identity.',
      });
    const result = await deps.startOrgPlanSupervision(parsed.data);
    const status =
      result.kind === 'rejected'
        ? result.code === 'LAUNCH_CONFLICT'
          ? 409
          : 400
        : result.kind === 'blocked' &&
            ['CONTEXT_CHANGED', 'ACTIVE_SUPERVISION'].includes(result.code)
          ? 409
          : 200;
    return reply.code(status).send(result);
  });
}
