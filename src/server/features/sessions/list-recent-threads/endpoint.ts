/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import { buildResumeCommand } from '../application/resume-command.js';

export type RecentThread = {
  id: string;
  cwd: string;
  profile: string;
  recencyAt: number | null;
};

type RecentThreadMetadata = {
  model?: string;
  skillProfile?: string;
  orgPlanFilename?: string;
};

export function registerListRecentThreads(
  app: FastifyInstance,
  deps: { list(): Promise<RecentThread[]>; metadata?(threadId: string): RecentThreadMetadata | null },
): void {
  app.get('/api/sessions/recent-threads', async () => {
    const threads = await deps.list();
    return threads.map(({ id, cwd, profile, recencyAt }) => {
      const metadata = deps.metadata?.(id);
      return {
        id,
        cwd,
        recencyAt,
        ...(metadata?.model === undefined ? {} : { model: metadata.model }),
        ...(metadata?.skillProfile === undefined ? {} : { skillProfile: metadata.skillProfile }),
        ...(metadata?.orgPlanFilename === undefined ? {} : { orgPlanFilename: metadata.orgPlanFilename }),
        resumeCommand: buildResumeCommand({ profile, threadId: id, workspacePath: cwd }),
      };
    });
  });
}
