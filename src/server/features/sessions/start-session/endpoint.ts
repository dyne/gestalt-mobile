import type { FastifyInstance } from 'fastify';
import { idempotencyKey } from '../../../platform/http/idempotency.js';
import { parseStartSessionRequest } from './request.js';
import { startSession } from './use-case.js';

export function registerStartSession(
  app: FastifyInstance,
  deps: Parameters<typeof startSession>[1] & {
    idempotency?: {
      get(scope: string, key: string): { statusCode: number; body: string } | null;
      put(scope: string, key: string, statusCode: number, body: string): void;
    };
    reportFailure?(operation: string, error: unknown): void;
  },
): void {
  app.post('/api/sessions', async (request, reply) => {
    const key = idempotencyKey(request.headers);
    const prior = key ? deps.idempotency?.get('start-session', key) : null;
    if (prior) return reply.code(prior.statusCode).send(JSON.parse(prior.body));
    const body = parseStartSessionRequest(request.body);
    if (!body)
      return reply.code(400).type('application/problem+json').send({
        type: 'urn:gestalt-mobile:error:invalid-start-session-request',
        title: 'Invalid start session request',
        status: 400,
        detail: 'Workspace, profile, and Codex session settings must be valid.',
        code: 'INVALID_START_SESSION_REQUEST',
        retryable: false,
      });
    let started;
    try {
      started = await startSession(body, deps);
    } catch (error) {
      deps.reportFailure?.('start-session', error);
      throw error;
    }
    if (key) deps.idempotency?.put('start-session', key, 202, JSON.stringify(started));
    return reply.code(202).send(started);
  });
}
