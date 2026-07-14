import type { FastifyInstance } from 'fastify';

import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { buildResumeCommand } from '../application/resume-command.js';

export function registerListSessions(
  app: FastifyInstance,
  deps: { list(): RelaySessionSnapshot[] },
): void {
  app.get('/api/sessions', async () =>
    deps.list().map((session) => ({
      ...session,
      resumeCommand: session.threadId ? buildResumeCommand(session) : null,
    })),
  );
}
