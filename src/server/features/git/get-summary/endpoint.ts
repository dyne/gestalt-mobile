/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { RelaySessionSnapshot } from '../../sessions/model/relay-session.js';
import type { WorkspaceGitSummary } from '../../../platform/git/git-inspector.js';

export function registerGetGitSummary(
  app: FastifyInstance,
  deps: {
    find(id: string): RelaySessionSnapshot | null;
    inspect(path: string): Promise<WorkspaceGitSummary>;
  },
): void {
  app.get('/api/sessions/:id/git', async (request, reply) => {
    const session = deps.find((request.params as { id: string }).id);
    return session
      ? reply.send(await deps.inspect(session.workspacePath))
      : reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
  });
}
