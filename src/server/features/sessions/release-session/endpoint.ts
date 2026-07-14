import type { FastifyInstance } from 'fastify';

import type { RelaySessionSnapshot } from '../model/relay-session.js';

export function registerReleaseSession(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    release(session: RelaySessionSnapshot): RelaySessionSnapshot;
    save(session: RelaySessionSnapshot): void;
    close(id: string): void;
  },
): void {
  app.post('/api/sessions/:id/release', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const session = deps.find(id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const released = deps.release(session);
    deps.save(released);
    deps.close(id);
    return reply.code(202).send(released);
  });
}
