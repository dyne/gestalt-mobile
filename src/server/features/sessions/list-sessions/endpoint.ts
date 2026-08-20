/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { buildResumeCommand } from '../application/resume-command.js';

export function registerListSessions(
  app: FastifyInstance,
  deps: {
    list(): RelaySessionSnapshot[];
    activity?: (id: string) => import('../../agent-activity/model.js').AgentActivitySnapshot;
    autopilot?: (
      id: string,
    ) => import('../../autopilot/domain/autopilot-session.js').AutopilotSnapshot;
  },
): void {
  app.get('/api/sessions', async () =>
    deps.list().map((session) => ({
      ...session,
      ...(deps.activity ? { agentActivity: deps.activity(session.id) } : {}),
      ...(deps.autopilot ? { autopilot: deps.autopilot(session.id) } : {}),
      resumeCommand: session.threadId ? buildResumeCommand(session) : null,
    })),
  );
}
