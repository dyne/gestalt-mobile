/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { WorkspaceCatalog } from '../../catalog/application/ports.js';
import type { WorkspaceFileSource } from '../application/ports.js';

export function registerCheckReferences(
  app: FastifyInstance,
  deps: {
    workspaces: Pick<WorkspaceCatalog, 'resolve'>;
    files: WorkspaceFileSource;
  },
): void {
  if (!deps.files.exists) return;
  app.post('/api/workspaces/:workspaceId/files/references', async (request, reply) => {
    const body = request.body as { paths?: unknown } | null;
    const paths = body?.paths;
    if (
      !Array.isArray(paths) ||
      paths.length > 64 ||
      !paths.every(
        (path) => typeof path === 'string' && path.length <= 4096 && !path.includes('\0'),
      )
    )
      return reply.code(400).send({ code: 'INVALID_FILE_REFERENCES' });
    try {
      const workspace = await deps.workspaces.resolve(
        (request.params as { workspaceId: string }).workspaceId,
      );
      const unique: string[] = [...new Set(paths)];
      const existing: string[] = [];
      for (let index = 0; index < unique.length; index += 8) {
        const group = unique.slice(index, index + 8);
        const results = await Promise.all(
          group.map((path) => deps.files.exists!(workspace.realPath, path)),
        );
        group.forEach((path, offset) => {
          if (results[offset]) existing.push(path);
        });
      }
      return reply.send({ paths: existing });
    } catch (error) {
      if (error instanceof Error && error.message === 'WORKSPACE_NOT_FOUND')
        return reply.code(404).send({ code: 'WORKSPACE_NOT_FOUND' });
      return reply.code(503).send({ code: 'WORKSPACE_FILES_UNAVAILABLE' });
    }
  });
}
