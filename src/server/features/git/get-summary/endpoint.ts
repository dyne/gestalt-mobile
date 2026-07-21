/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { GitSummary, GitWorkspaceResolver } from '../application/ports.js';
import { resolveRepositoryTarget } from '../application/repository-target.js';

export function registerGetGitSummary(
  app: FastifyInstance,
  deps: {
    workspaces: GitWorkspaceResolver;
    inspect(path: string): Promise<GitSummary>;
  },
): void {
  app.get('/api/git/repositories/:workspaceId', async (request, reply) => {
    const target = await resolveRepositoryTarget(
      deps.workspaces,
      (request.params as { workspaceId: string }).workspaceId,
    );
    if (!target.ok) return reply.code(target.statusCode).send({ code: target.code });
    return reply.send(await deps.inspect(target.path));
  });
}
