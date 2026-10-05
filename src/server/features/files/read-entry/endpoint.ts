/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from 'fastify';
import type { WorkspaceCatalog } from '../../catalog/application/ports.js';
import type { WorkspaceFileSource } from '../application/ports.js';

export function registerReadEntry(
  app: FastifyInstance,
  deps: {
    workspaces: Pick<WorkspaceCatalog, 'resolve'>;
    files: WorkspaceFileSource;
  },
): void {
  if (!deps.files.read) return;
  app.get('/api/workspaces/:workspaceId/files/preview', async (request, reply) => {
    const { path } = request.query as Record<string, unknown>;
    if (typeof path !== 'string' || path.includes('\0') || path.length > 4096)
      return reply.code(400).send({ code: 'INVALID_FILE_PREVIEW' });
    try {
      const workspace = await deps.workspaces.resolve(
        (request.params as { workspaceId: string }).workspaceId,
      );
      const result = await deps.files.read!(workspace.realPath, path);
      if (result.kind === 'available') return reply.send(result.preview);
      const errors = {
        missing: [404, 'FILE_PREVIEW_NOT_FOUND'],
        unreadable: [403, 'FILE_PREVIEW_UNREADABLE'],
        unsupported: [415, 'FILE_PREVIEW_UNSUPPORTED'],
        'too-large': [413, 'FILE_PREVIEW_TOO_LARGE'],
      } as const;
      const [status, code] = errors[result.kind];
      return reply.code(status).send({ code });
    } catch (error) {
      if (error instanceof Error && error.message === 'WORKSPACE_NOT_FOUND')
        return reply.code(404).send({ code: 'WORKSPACE_NOT_FOUND' });
      return reply.code(503).send({ code: 'WORKSPACE_FILES_UNAVAILABLE' });
    }
  });
}
