import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { RecentThread } from '../list-recent-threads/endpoint.js';
import type { RelaySessionSnapshot } from '../model/relay-session.js';

const requestSchema = z.object({
  threadId: z.string().min(1),
  cwd: z.string().startsWith('/'),
});

export function registerPromoteRecentThread(
  app: FastifyInstance,
  deps: {
    list(): Promise<RecentThread[]>;
    promote(thread: RecentThread): Promise<RelaySessionSnapshot>;
  },
): void {
  app.post('/api/sessions/recent-threads/open', async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_RECENT_THREAD' });
    const thread = (await deps.list()).find(
      (candidate) =>
        candidate.id === parsed.data.threadId && candidate.cwd === parsed.data.cwd,
    );
    if (!thread) return reply.code(404).send({ code: 'RECENT_THREAD_NOT_FOUND' });
    try {
      return reply.code(202).send(await deps.promote(thread));
    } catch (error) {
      return reply.code(409).send({
        code: 'RECENT_THREAD_OPEN_FAILED',
        detail: error instanceof Error ? error.message : 'Could not open the recent session.',
      });
    }
  });
}
