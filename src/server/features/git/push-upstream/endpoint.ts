import type { FastifyInstance } from 'fastify';

import type { RelaySessionSnapshot } from '../../sessions/model/relay-session.js';
import { mayPush } from '../push-policy.js';
import type { WorkspaceGitSummary } from '../../../platform/git/git-inspector.js';

export function registerPushUpstream(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    inspect(path: string): Promise<WorkspaceGitSummary>;
    push(path: string, upstream: string): Promise<void>;
  },
): void {
  app.post('/api/sessions/:id/git/push', async (request, reply) => {
    const session = deps.find((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const summary = await deps.inspect(session.workspacePath);
    const allowed = mayPush(summary);
    if (!allowed.allowed || !summary.upstream)
      return reply.code(409).send({ code: allowed.reason ?? 'GIT_PUSH_UNAVAILABLE' });
    await deps.push(session.workspacePath, summary.upstream);
    return reply.code(202).send({ accepted: true });
  });
}
