import type { FastifyInstance } from 'fastify';

import type { RelaySessionSnapshot } from '../model/relay-session.js';

export function registerForgetSession(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    close(id: string): void;
    remove(id: string): void;
  },
): void {
  app.delete('/api/sessions/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!deps.find(id)) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    deps.close(id);
    deps.remove(id);
    return reply.code(204).send();
  });
}
