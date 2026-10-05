/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { WorkspaceCatalog } from '../../catalog/application/ports.js';
import type { WorkspacePlanArchiveSource } from '../application/ports.js';

export function registerArchiveWorkspacePlan(
  app: FastifyInstance,
  deps: {
    workspaces: Pick<WorkspaceCatalog, 'resolve'>;
    archiver: WorkspacePlanArchiveSource;
  },
): void {
  app.post('/api/workspaces/:workspaceId/plans/:planName/archive', async (request, reply) => {
    try {
      const { workspaceId, planName } = request.params as { workspaceId: string; planName: string };
      const workspace = await deps.workspaces.resolve(workspaceId);
      const result = await deps.archiver.archive(workspace.realPath, planName);
      if (result.kind === 'archived') return reply.send({ archived: true });
      if (result.kind === 'missing') return reply.code(404).send({ code: 'PLAN_NOT_FOUND' });
      if (result.kind === 'conflict')
        return reply.code(409).send({ code: 'PLAN_ARCHIVE_CONFLICT' });
      return reply.code(422).send({ code: 'PLAN_ARCHIVE_UNAVAILABLE' });
    } catch (error) {
      if (error instanceof Error && error.message === 'WORKSPACE_NOT_FOUND')
        return reply.code(404).send({ code: 'WORKSPACE_NOT_FOUND' });
      return reply.code(503).send({ code: 'PLAN_ARCHIVE_UNAVAILABLE' });
    }
  });
}
