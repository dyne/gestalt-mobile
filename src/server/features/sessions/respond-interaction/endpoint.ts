import type { FastifyInstance } from 'fastify';

export function registerRespondInteraction(
  app: FastifyInstance,
  deps: {
    exists(sessionId: string): boolean;
    resolve(sessionId: string, requestId: string, resolvedAt: string): boolean;
    reply(sessionId: string, requestId: string, value: unknown): boolean;
    now(): string;
  },
): void {
  app.post('/api/sessions/:id/interactions/:requestId', async (request, reply) => {
    const { id, requestId } = request.params as { id: string; requestId: string };
    if (!deps.exists(id)) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    if (!deps.resolve(id, requestId, deps.now()))
      return reply.code(409).send({ code: 'INTERACTION_NOT_PENDING' });
    const value = request.body;
    if (!deps.reply(id, requestId, value))
      return reply.code(409).send({ code: 'INTERACTION_NOT_PENDING' });
    return reply.code(202).send({ accepted: true });
  });
}
