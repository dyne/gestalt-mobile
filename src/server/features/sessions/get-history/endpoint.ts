import type { FastifyInstance } from 'fastify';

import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { toChatItems, type ChatItem } from './history-mapper.js';

export function registerGetHistory(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    read(session: RelaySessionSnapshot): Promise<Array<Record<string, unknown>>>;
  },
): void {
  app.get('/api/sessions/:id/history', async (request, reply) => {
    const session = deps.find((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    const items: ChatItem[] = toChatItems(await deps.read(session));
    return reply.send({ items });
  });
}
