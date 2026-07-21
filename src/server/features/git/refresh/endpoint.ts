/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import { idempotencyKey } from '../../../platform/http/idempotency.js';
import type { GitWorkspaceResolver } from '../application/ports.js';
import { resolveRepositoryTarget } from '../application/repository-target.js';

export function registerRefreshGit(
  app: FastifyInstance,
  deps: {
    workspaces: GitWorkspaceResolver;
    refresh(path: string): Promise<void>;
    idempotency?: {
      get(scope: string, key: string): { statusCode: number; body: string } | null;
      put(scope: string, key: string, statusCode: number, body: string): void;
    };
  },
): void {
  app.post('/api/git/repositories/:workspaceId/refresh', async (request, reply) => {
    const id = (request.params as { workspaceId: string }).workspaceId;
    const key = idempotencyKey(request.headers);
    const scope = `refresh-git:${id}`;
    const prior = key ? deps.idempotency?.get(scope, key) : null;
    if (prior) return reply.code(prior.statusCode).send(JSON.parse(prior.body));
    const target = await resolveRepositoryTarget(deps.workspaces, id);
    if (!target.ok) return reply.code(target.statusCode).send({ code: target.code });
    await deps.refresh(target.path);
    const body = { accepted: true };
    if (key) deps.idempotency?.put(scope, key, 202, JSON.stringify(body));
    return reply.code(202).send(body);
  });
}
