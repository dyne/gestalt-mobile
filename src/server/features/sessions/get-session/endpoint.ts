/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { buildResumeCommand } from '../application/resume-command.js';

export function registerGetSession(
  app: FastifyInstance,
  find: (id: string) => RelaySessionSnapshot | null,
): void {
  app.get('/api/sessions/:id', async (request, reply) => {
    const session = find((request.params as { id: string }).id);
    return session
      ? reply.send({
          ...session,
          resumeCommand: session.threadId ? buildResumeCommand(session) : null,
        })
      : reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
  });
}
