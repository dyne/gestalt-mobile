/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { GitWorkspaceResolver } from '../application/ports.js';
import { resolveRepositoryTarget } from '../application/repository-target.js';

export function registerPullRebase(
  app: FastifyInstance,
  deps: {
    workspaces: GitWorkspaceResolver;
    pull(path: string): Promise<void>;
  },
): void {
  app.post('/api/git/repositories/:workspaceId/pull', async (request, reply) => {
    const target = await resolveRepositoryTarget(
      deps.workspaces,
      (request.params as { workspaceId: string }).workspaceId,
    );
    if (!target.ok) return reply.code(target.statusCode).send({ code: target.code });
    try {
      await deps.pull(target.path);
      return reply.code(202).send({ accepted: true });
    } catch (error) {
      return reply.code(409).send({
        code: 'GIT_PULL_FAILED',
        detail: error instanceof Error ? error.message : 'Git pull --rebase failed.',
      });
    }
  });
}
