/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WorkspaceCatalog } from '../../catalog/application/ports.js';
import type {
  CopyMoveInput,
  FileMutationResult,
  WorkspaceFileSource,
} from '../application/ports.js';

export function registerCopyEntry(
  app: FastifyInstance,
  deps: { workspaces: Pick<WorkspaceCatalog, 'resolve'>; files: WorkspaceFileSource },
): void {
  app.post('/api/workspaces/:workspaceId/files/copy', async (request, reply) =>
    mutation(request, reply, deps, 'copy'),
  );
}
export async function mutation(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: { workspaces: Pick<WorkspaceCatalog, 'resolve'>; files: WorkspaceFileSource },
  operation: 'copy' | 'move',
) {
  const body = request.body as Partial<CopyMoveInput>;
  if (
    !body ||
    typeof body.source !== 'string' ||
    typeof body.destinationDirectory !== 'string' ||
    !['reject', 'replace', 'keep-both'].includes(body.conflict ?? '')
  )
    return reply.code(400).send({ code: 'INVALID_FILE_MUTATION' });
  const method = deps.files[operation];
  if (!method) return reply.code(503).send({ code: 'WORKSPACE_FILES_UNAVAILABLE' });
  try {
    const workspace = await deps.workspaces.resolve(
      (request.params as { workspaceId: string }).workspaceId,
    );
    const result = await method.call(deps.files, workspace.realPath, body as CopyMoveInput);
    return map(reply, result);
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
}
export function map(reply: FastifyReply, result: FileMutationResult) {
  if (result.kind === 'available') return reply.send(result);
  const mapped: Record<string, [number, string]> = {
    missing: [404, 'FILE_NOT_FOUND'],
    protected: [403, 'FILE_PROTECTED'],
    symlink: [409, 'SYMLINK_UNSUPPORTED'],
    'invalid-destination': [400, 'INVALID_FILE_DESTINATION'],
    'source-inside-destination': [409, 'SOURCE_INSIDE_DESTINATION'],
    'same-parent': [409, 'SAME_PARENT_MOVE'],
    conflict: [409, 'FILE_CONFLICT'],
    'replace-unsupported': [409, 'FILE_REPLACE_UNSUPPORTED'],
    unreadable: [503, 'WORKSPACE_FILES_UNAVAILABLE'],
  };
  const [status, code] = mapped[result.kind] ?? [503, 'WORKSPACE_FILES_UNAVAILABLE'];
  return reply.code(status).send({
    code,
    ...(result.kind === 'conflict' ? { replaceAllowed: result.replaceAllowed } : {}),
  });
}
