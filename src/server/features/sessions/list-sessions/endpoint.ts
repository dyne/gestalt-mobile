import type { FastifyInstance } from 'fastify';

import type { RelaySessionSnapshot } from '../model/relay-session.js';

export function registerListSessions(
  app: FastifyInstance,
  deps: { list(): RelaySessionSnapshot[] },
): void {
  app.get('/api/sessions', async () => deps.list());
}
