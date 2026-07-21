/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import { idempotencyKey } from '../../../platform/http/idempotency.js';
import { mayPush } from '../push-policy.js';
import type { GitSummary, GitWorkspaceResolver } from '../application/ports.js';
import { resolveRepositoryTarget } from '../application/repository-target.js';

export function registerPushUpstream(
  app: FastifyInstance,
  deps: {
    workspaces: GitWorkspaceResolver;
    inspect(path: string): Promise<GitSummary>;
    push(path: string, upstream: string): Promise<void>;
    idempotency?: {
      get(scope: string, key: string): { statusCode: number; body: string } | null;
      put(scope: string, key: string, statusCode: number, body: string): void;
    };
  },
): void {
  app.post('/api/git/repositories/:workspaceId/push', async (request, reply) => {
    const id = (request.params as { workspaceId: string }).workspaceId;
    const key = idempotencyKey(request.headers);
    const scope = `push-git:${id}`;
    const prior = key ? deps.idempotency?.get(scope, key) : null;
    if (prior) return reply.code(prior.statusCode).send(JSON.parse(prior.body));
    const target = await resolveRepositoryTarget(deps.workspaces, id);
    if (!target.ok) return reply.code(target.statusCode).send({ code: target.code });
    const summary = await deps.inspect(target.path);
    const allowed = mayPush(summary);
    if (!allowed.allowed || !summary.upstream)
      return reply.code(409).send({ code: allowed.reason ?? 'GIT_PUSH_UNAVAILABLE' });
    await deps.push(target.path, summary.upstream);
    const body = { accepted: true };
    if (key) deps.idempotency?.put(scope, key, 202, JSON.stringify(body));
    return reply.code(202).send(body);
  });
}
