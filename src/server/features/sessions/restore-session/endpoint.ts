import type { FastifyInstance } from 'fastify';

import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { canRestore } from './use-case.js';

export function registerRestoreSession(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    restore(session: RelaySessionSnapshot): Promise<RelaySessionSnapshot>;
    save(session: RelaySessionSnapshot): void;
  },
): void {
  app.post('/api/sessions/:id/restore', async (request, reply) => {
    const session = deps.find((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    if (!canRestore(session)) return reply.code(409).send({ code: 'SESSION_CANNOT_RESTORE' });
    const restored = await deps.restore(session);
    deps.save(restored);
    return reply.send(restored);
  });
}
