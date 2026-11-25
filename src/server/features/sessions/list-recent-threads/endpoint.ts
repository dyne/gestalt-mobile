/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { LlmProvider } from '../../../../shared/contracts/llm-provider.js';
import { buildResumeCommand } from '../application/resume-command.js';

export type RecentThread = {
  id: string;
  cwd: string;
  profile: string;
  recencyAt: number | null;
  /** Owning llm service; absent denotes a codex thread from before providers. */
  provider?: LlmProvider;
};

type ManagedThread = {
  threadId: string | null;
  provider?: LlmProvider;
  model?: string;
  effectiveSkillSelection?: { selectedProfileName?: string };
  lastOrgPlan?: { filename: string };
};

export function registerListRecentThreads(
  app: FastifyInstance,
  deps: {
    list(): Promise<RecentThread[]>;
    listManaged?(): ManagedThread[];
  },
): void {
  app.get('/api/sessions/recent-threads', async () => {
    const threads = await deps.list();
    if (!threads.length) return [];
    const managed = new Map<string, ManagedThread>();
    for (const session of deps.listManaged?.() ?? []) {
      if (!session.threadId) continue;
      const key = `${session.provider ?? 'codex'}:${session.threadId}`;
      if (!managed.has(key)) managed.set(key, session);
    }
    return threads.map(({ id, cwd, recencyAt, provider }) => {
      const session = managed.get(`${provider ?? 'codex'}:${id}`);
      return {
        id,
        cwd,
        recencyAt,
        ...(provider ? { provider } : {}),
        model: session?.model,
        skillProfile: session?.effectiveSkillSelection?.selectedProfileName,
        orgPlanFilename: session?.lastOrgPlan?.filename,
        // The CLI resume command is codex-specific; kimi threads open in the
        // relay without one.
        ...(provider === 'kimi'
          ? {}
          : { resumeCommand: buildResumeCommand({ threadId: id, workspacePath: cwd }) }),
      };
    });
  });
}
