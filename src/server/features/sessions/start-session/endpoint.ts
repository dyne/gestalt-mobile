import type { FastifyInstance } from 'fastify';
import { startSession } from './use-case.js';

export function registerStartSession(
  app: FastifyInstance,
  deps: Parameters<typeof startSession>[1],
): void {
  app.post('/api/sessions', async (request, reply) => {
    const body = request.body as { workspaceId: string; profile: string };
    return reply.code(202).send(await startSession(body, deps));
  });
}
