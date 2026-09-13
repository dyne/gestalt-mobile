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

export function registerListSessions(
  app: FastifyInstance,
  deps: {
    list(): RelaySessionSnapshot[];
    activity?: (id: string) => import('../../agent-activity/model.js').AgentActivitySnapshot;
    autopilot?: (
      id: string,
    ) => import('../../autopilot/domain/autopilot-session.js').AutopilotSnapshot;
    plan?: (id: string) => import('../../plans/domain/supervised-plan.js').SupervisedPlan | null;
  },
): void {
  app.get('/api/sessions', async () =>
    deps.list().map((session) => {
      const plan = deps.plan?.(session.id) ?? null;
      const activity = deps.activity?.(session.id) ?? null;
      const autopilot = deps.autopilot?.(session.id) ?? null;
      return {
        ...session,
        ...(activity ? { agentActivity: toAgentActivityDto(activity) } : {}),
        ...(autopilot ? { autopilot } : {}),
        ...(plan ? { plan } : {}),
        sessionStatus: deriveSessionStatus({
          session,
          plan,
          activity,
          autopilot,
          pendingAttention: Boolean(session.pendingInteractions?.length),
          observedAt: new Date().toISOString(),
        }),
        resumeCommand: session.threadId ? buildResumeCommand(session) : null,
      };
    }),
  );
}
