/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from 'fastify';
import type { WorkspaceCatalog } from '../../catalog/application/ports.js';
import type { FileConflict, WorkspaceFileSource } from '../application/ports.js';
import { map } from '../copy-entry/endpoint.js';
export function registerUploadFile(
  app: FastifyInstance,
  deps: { workspaces: Pick<WorkspaceCatalog, 'resolve'>; files: WorkspaceFileSource },
): void {
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );
  app.put(
    '/api/workspaces/:workspaceId/files/upload',
    { bodyLimit: 25 * 1024 * 1024 },
    async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      const conflict = q.conflict;
      if (
        typeof q.directory !== 'string' ||
        typeof q.filename !== 'string' ||
        !['reject', 'replace', 'keep-both'].includes(String(conflict))
      )
        return reply.code(400).send({ code: 'INVALID_UPLOAD_REQUEST' });
      if (!deps.files.upload) return reply.code(503).send({ code: 'WORKSPACE_FILES_UNAVAILABLE' });
      try {
        const workspace = await deps.workspaces.resolve(
          (request.params as { workspaceId: string }).workspaceId,
        );
        if (!Buffer.isBuffer(request.body))
          return reply.code(415).send({ code: 'INVALID_UPLOAD_CONTENT' });
        const content = request.body;
        return map(
          reply,
          await deps.files.upload(workspace.realPath, {
            directory: q.directory,
            filename: q.filename,
            conflict: conflict as FileConflict,
            content,
          }),
        );
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
    },
  );
}
