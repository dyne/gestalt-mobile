/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { buildResumeCommand } from '../application/resume-command.js';
import { toAgentActivityDto } from '../../agent-activity/activity-dto.js';
import { deriveSessionStatus } from '../session-status.js';

export function registerGetSession(
  app: FastifyInstance,
  find: (id: string) => RelaySessionSnapshot | null,
  activity?: (id: string) => import('../../agent-activity/model.js').AgentActivitySnapshot,
  autopilot?: (
    id: string,
  ) => import('../../autopilot/domain/autopilot-session.js').AutopilotSnapshot,
  plan?: (id: string) => import('../../plans/domain/supervised-plan.js').SupervisedPlan | null,
): void {
  app.get('/api/sessions/:id', async (request, reply) => {
    const session = find((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const activitySnapshot = activity?.(session.id) ?? null;
    const autopilotSnapshot = autopilot?.(session.id) ?? null;
    const retainedPlan = plan?.(session.id) ?? null;
    return reply.send({
      ...session,
      ...(activitySnapshot ? { agentActivity: toAgentActivityDto(activitySnapshot) } : {}),
      ...(autopilotSnapshot ? { autopilot: autopilotSnapshot } : {}),
      ...(retainedPlan ? { plan: retainedPlan } : {}),
      sessionStatus: deriveSessionStatus({
        session,
        plan: retainedPlan,
        activity: activitySnapshot,
        autopilot: autopilotSnapshot,
        pendingAttention: Boolean(session.pendingInteractions?.length),
        observedAt: new Date().toISOString(),
      }),
      resumeCommand: session.threadId ? buildResumeCommand(session) : null,
    });
  });
}
