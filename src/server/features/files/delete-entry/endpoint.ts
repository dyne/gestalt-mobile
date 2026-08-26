/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from 'fastify';
import type { WorkspaceCatalog } from '../../catalog/application/ports.js';
import type { WorkspaceFileSource } from '../application/ports.js';
import { map } from '../copy-entry/endpoint.js';
export function registerDeleteEntry(
  app: FastifyInstance,
  deps: { workspaces: Pick<WorkspaceCatalog, 'resolve'>; files: WorkspaceFileSource },
): void {
  app.delete('/api/workspaces/:workspaceId/files', async (request, reply) => {
    const body = request.body as { path?: unknown; recursive?: unknown };
    if (typeof body?.path !== 'string' || body.recursive !== true)
      return reply.code(400).send({ code: 'INVALID_DELETE_REQUEST' });
    if (!deps.files.delete) return reply.code(503).send({ code: 'WORKSPACE_FILES_UNAVAILABLE' });
    try {
      const w = await deps.workspaces.resolve(
        (request.params as { workspaceId: string }).workspaceId,
      );
      return map(reply, await deps.files.delete(w.realPath, { path: body.path, recursive: true }));
    } catch (error) {
      return reply
        .code(error instanceof Error && error.message === 'WORKSPACE_NOT_FOUND' ? 404 : 503)
        .send({
          code:
            error instanceof Error && error.message === 'WORKSPACE_NOT_FOUND'
              ? 'WORKSPACE_NOT_FOUND'
              : 'WORKSPACE_FILES_UNAVAILABLE',
        });
    }
  });
}
