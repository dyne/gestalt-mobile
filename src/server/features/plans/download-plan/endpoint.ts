/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import {
  orgPlanLaunchRequestSchema,
  type OrgPlanReference,
} from '../../../../shared/contracts/org-plan-execution.js';

export type DownloadOrgPlanDependencies = {
  resolveReference(
    reference: OrgPlanReference,
  ): Promise<{ workspacePath: string; planName: string } | null>;
  readSource(
    workspacePath: string,
    planName: string,
  ): Promise<{ kind: 'available'; source: string } | { kind: 'missing' | 'unavailable' }>;
};

export function registerDownloadOrgPlan(
  app: FastifyInstance,
  deps: DownloadOrgPlanDependencies,
): void {
  app.post('/api/plans/download', async (request, reply) => {
    const reference = orgPlanLaunchRequestSchema.shape.reference.safeParse(request.body);
    if (!reference.success) return reply.code(400).send({ code: 'PLAN_REFERENCE_REQUIRED' });
    try {
      const resolved = await deps.resolveReference(reference.data);
      if (!resolved) return reply.code(404).send({ code: 'PLAN_NOT_FOUND' });
      const result = await deps.readSource(resolved.workspacePath, resolved.planName);
      if (result.kind === 'missing') return reply.code(404).send({ code: 'PLAN_NOT_FOUND' });
      if (result.kind !== 'available') return reply.code(422).send({ code: 'PLAN_UNAVAILABLE' });
      const filename = encodeURIComponent(resolved.planName.split('/').at(-1)!).replace(
        /['()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      return reply
        .header('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
        .header('Cache-Control', 'no-store')
        .type('text/plain; charset=utf-8')
        .send(result.source);
    } catch (error) {
      if (error instanceof Error && error.message === 'WORKSPACE_NOT_FOUND')
        return reply.code(404).send({ code: 'WORKSPACE_NOT_FOUND' });
      return reply.code(503).send({ code: 'PLAN_DOWNLOAD_UNAVAILABLE' });
    }
  });
}
