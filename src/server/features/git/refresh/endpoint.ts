import type { FastifyInstance } from 'fastify';

import type { RelaySessionSnapshot } from '../../sessions/model/relay-session.js';

export function registerRefreshGit(
  app: FastifyInstance,
  deps: { find(id: string): RelaySessionSnapshot | null; refresh(path: string): Promise<void> },
): void {
  app.post('/api/sessions/:id/git/refresh', async (request, reply) => {
    const session = deps.find((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    await deps.refresh(session.workspacePath);
    return reply.code(202).send({ accepted: true });
  });
}
