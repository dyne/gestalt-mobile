/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GitWorkspaceResolver } from '../application/ports.js';
import { resolveRepositoryTarget } from '../application/repository-target.js';

const requestSchema = z.object({ branch: z.string().min(1) });

export function registerCheckoutBranch(
  app: FastifyInstance,
  deps: {
    workspaces: GitWorkspaceResolver;
    checkout(path: string, branch: string): Promise<void>;
  },
): void {
  app.post('/api/git/repositories/:workspaceId/checkout', async (request, reply) => {
    const target = await resolveRepositoryTarget(
      deps.workspaces,
      (request.params as { workspaceId: string }).workspaceId,
    );
    if (!target.ok) return reply.code(target.statusCode).send({ code: target.code });
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_BRANCH' });
    try {
      await deps.checkout(target.path, parsed.data.branch);
      return reply.code(202).send({ accepted: true });
    } catch (error) {
      return reply.code(409).send({
        code: 'GIT_CHECKOUT_FAILED',
        detail: error instanceof Error ? error.message : 'Git checkout failed.',
      });
    }
  });
}
