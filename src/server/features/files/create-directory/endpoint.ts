/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { WorkspaceCatalog } from '../../catalog/application/ports.js';
import type { WorkspaceFileSource } from '../application/ports.js';
import { parseRelativeDirectory } from '../domain/relative-directory.js';
import { map } from '../copy-entry/endpoint.js';

export function registerCreateDirectory(
  app: FastifyInstance,
  deps: { workspaces: Pick<WorkspaceCatalog, 'resolve'>; files: WorkspaceFileSource },
): void {
  app.post(
    '/api/workspaces/:workspaceId/files/directories',
    { bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const body = request.body as { directory?: unknown; name?: unknown } | null;
      if (
        typeof body?.directory !== 'string' ||
        parseRelativeDirectory(body.directory) === null ||
        typeof body.name !== 'string' ||
        !body.name.trim() ||
        body.name.length > 255 ||
        body.name.includes('/') ||
        parseRelativeDirectory(body.name) === null
      )
        return reply.code(400).send({ code: 'INVALID_CREATE_DIRECTORY_REQUEST' });
      if (!deps.files.createDirectory)
        return reply.code(503).send({ code: 'WORKSPACE_FILES_UNAVAILABLE' });
      try {
        const workspace = await deps.workspaces.resolve(
          (request.params as { workspaceId: string }).workspaceId,
        );
        return map(
          reply.code(201),
          await deps.files.createDirectory(workspace.realPath, {
            directory: body.directory,
            name: body.name,
          }),
        );
      } catch (error) {
        const missing = error instanceof Error && error.message === 'WORKSPACE_NOT_FOUND';
        return reply
          .code(missing ? 404 : 503)
          .send({ code: missing ? 'WORKSPACE_NOT_FOUND' : 'WORKSPACE_FILES_UNAVAILABLE' });
      }
    },
  );
}
