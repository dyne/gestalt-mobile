import type { FastifyInstance } from 'fastify';
import { idempotencyKey } from '../../../platform/http/idempotency.js';
import { startSession } from './use-case.js';

export function registerStartSession(
  app: FastifyInstance,
  deps: Parameters<typeof startSession>[1] & {
    idempotency?: {
      get(scope: string, key: string): { statusCode: number; body: string } | null;
      put(scope: string, key: string, statusCode: number, body: string): void;
    };
  },
): void {
  app.post('/api/sessions', async (request, reply) => {
    const key = idempotencyKey(request.headers);
    const prior = key ? deps.idempotency?.get('start-session', key) : null;
    if (prior) return reply.code(prior.statusCode).send(JSON.parse(prior.body));
    const body = request.body as { workspaceId: string; profile: string };
    const started = await startSession(body, deps);
    if (key) deps.idempotency?.put('start-session', key, 202, JSON.stringify(started));
    return reply.code(202).send(started);
  });
}
