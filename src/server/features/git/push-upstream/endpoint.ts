import type { FastifyInstance } from 'fastify';

import { idempotencyKey } from '../../../platform/http/idempotency.js';
import type { RelaySessionSnapshot } from '../../sessions/model/relay-session.js';
import { mayPush } from '../push-policy.js';
import type { WorkspaceGitSummary } from '../../../platform/git/git-inspector.js';

export function registerPushUpstream(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    inspect(path: string): Promise<WorkspaceGitSummary>;
    push(path: string, upstream: string): Promise<void>;
    idempotency?: {
      get(scope: string, key: string): { statusCode: number; body: string } | null;
      put(scope: string, key: string, statusCode: number, body: string): void;
    };
  },
): void {
  app.post('/api/sessions/:id/git/push', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const key = idempotencyKey(request.headers);
    const scope = `push-git:${id}`;
    const prior = key ? deps.idempotency?.get(scope, key) : null;
    if (prior) return reply.code(prior.statusCode).send(JSON.parse(prior.body));
    const session = deps.find(id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const summary = await deps.inspect(session.workspacePath);
    const allowed = mayPush(summary);
    if (!allowed.allowed || !summary.upstream)
      return reply.code(409).send({ code: allowed.reason ?? 'GIT_PUSH_UNAVAILABLE' });
    await deps.push(session.workspacePath, summary.upstream);
    const body = { accepted: true };
    if (key) deps.idempotency?.put(scope, key, 202, JSON.stringify(body));
    return reply.code(202).send(body);
  });
}
