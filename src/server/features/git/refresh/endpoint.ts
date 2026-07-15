import type { FastifyInstance } from 'fastify';

import { idempotencyKey } from '../../../platform/http/idempotency.js';
import type { RelaySessionSnapshot } from '../../sessions/model/relay-session.js';

export function registerRefreshGit(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    refresh(path: string): Promise<void>;
    idempotency?: {
      get(scope: string, key: string): { statusCode: number; body: string } | null;
      put(scope: string, key: string, statusCode: number, body: string): void;
    };
  },
): void {
  app.post('/api/sessions/:id/git/refresh', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const key = idempotencyKey(request.headers);
    const scope = `refresh-git:${id}`;
    const prior = key ? deps.idempotency?.get(scope, key) : null;
    if (prior) return reply.code(prior.statusCode).send(JSON.parse(prior.body));
    const session = deps.find(id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    await deps.refresh(session.workspacePath);
    const body = { accepted: true };
    if (key) deps.idempotency?.put(scope, key, 202, JSON.stringify(body));
    return reply.code(202).send(body);
  });
}
