/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { WorkspaceCatalog } from '../../catalog/application/ports.js';
import type { WorkspacePlanCatalogSource } from '../application/ports.js';

export function registerListWorkspacePlans(
  app: FastifyInstance,
  deps: { workspaces: Pick<WorkspaceCatalog, 'resolve'>; plans: WorkspacePlanCatalogSource },
): void {
  app.get('/api/workspaces/:workspaceId/plans', async (request, reply) => {
    try {
      const workspace = await deps.workspaces.resolve(
        (request.params as { workspaceId: string }).workspaceId,
      );
      return reply.send(await deps.plans.list(workspace.realPath));
    } catch (error) {
      if (error instanceof Error && error.message === 'WORKSPACE_NOT_FOUND')
        return reply.code(404).send({ code: 'WORKSPACE_NOT_FOUND' });
      return reply.code(503).send({ code: 'PLAN_CATALOG_UNAVAILABLE' });
    }
  });
}
