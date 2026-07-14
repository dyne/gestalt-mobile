import type { FastifyInstance } from 'fastify';

import type { RelaySessionSnapshot } from '../model/relay-session.js';

export function registerStartTurn(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    start(session: RelaySessionSnapshot, text: string): Promise<RelaySessionSnapshot>;
    save(session: RelaySessionSnapshot): void;
  },
): void {
  app.post('/api/sessions/:id/turns', async (request, reply) => {
    const session = deps.find((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const text = (request.body as { text?: string }).text?.trim() ?? '';
    if (text.length > 100_000) return reply.code(400).send({ code: 'TURN_INPUT_TOO_LONG' });
    if (!text || session.state !== 'ready')
      return reply.code(409).send({ code: 'SESSION_NOT_READY' });
    const started = await deps.start(session, text);
    deps.save(started);
    return reply.code(202).send(started);
  });
}
