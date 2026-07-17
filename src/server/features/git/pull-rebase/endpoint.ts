/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { RelaySessionSnapshot } from '../../sessions/model/relay-session.js';

export function registerPullRebase(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    pull(path: string): Promise<void>;
  },
): void {
  app.post('/api/sessions/:id/git/pull', async (request, reply) => {
    const session = deps.find((request.params as { id: string }).id);
    if (!session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    try {
      await deps.pull(session.workspacePath);
      return reply.code(202).send({ accepted: true });
    } catch (error) {
      return reply.code(409).send({
        code: 'GIT_PULL_FAILED',
        detail: error instanceof Error ? error.message : 'Git pull --rebase failed.',
      });
    }
  });
}
