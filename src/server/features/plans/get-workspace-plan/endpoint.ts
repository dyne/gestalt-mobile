/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { WorkspaceCatalog } from '../../catalog/application/ports.js';
import type { WorkspacePlanCatalogSource } from '../application/ports.js';

export function registerGetWorkspacePlan(
  app: FastifyInstance,
  deps: { workspaces: Pick<WorkspaceCatalog, 'resolve'>; plans: WorkspacePlanCatalogSource },
): void {
  app.get('/api/workspaces/:workspaceId/plans/:planName', async (request, reply) => {
    try {
      const workspace = await deps.workspaces.resolve(
        (request.params as { workspaceId: string }).workspaceId,
      );
      const result = await deps.plans.read(
        workspace.realPath,
        (request.params as { planName: string }).planName,
      );
      if (result.kind === 'available') return reply.send(result.plan);
      if (result.kind === 'source')
        return reply.send({
          kind: 'org-source',
          planName: (request.params as { planName: string }).planName,
          title: result.title,
          source: result.source,
        });
      if (result.kind === 'missing') return reply.code(404).send({ code: 'PLAN_NOT_FOUND' });
      return reply.code(422).send({ code: 'PLAN_UNAVAILABLE' });
    } catch (error) {
      if (error instanceof Error && error.message === 'WORKSPACE_NOT_FOUND')
        return reply.code(404).send({ code: 'WORKSPACE_NOT_FOUND' });
      return reply.code(503).send({ code: 'PLAN_CATALOG_UNAVAILABLE' });
    }
  });
}
