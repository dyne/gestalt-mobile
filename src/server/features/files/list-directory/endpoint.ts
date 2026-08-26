/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { WorkspaceCatalog } from '../../catalog/application/ports.js';
import type { WorkspaceFileSource } from '../application/ports.js';
import { parseRelativeDirectory } from '../domain/relative-directory.js';

const defaultLimit = 250;
const maximumLimit = 500;

export function registerListDirectory(
  app: FastifyInstance,
  deps: { workspaces: Pick<WorkspaceCatalog, 'resolve'>; files: WorkspaceFileSource },
): void {
  app.get('/api/workspaces/:workspaceId/files', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const directoryRaw = query.directory === undefined ? '' : query.directory;
    const directory =
      typeof directoryRaw === 'string' ? parseRelativeDirectory(directoryRaw) : null;
    const cursor = query.cursor === undefined ? undefined : query.cursor;
    const limit = parseLimit(query.limit);
    if (
      directory === null ||
      (cursor !== undefined && (typeof cursor !== 'string' || cursor === '')) ||
      !limit
    )
      return reply.code(400).send({ code: 'INVALID_DIRECTORY_REQUEST' });
    try {
      const workspace = await deps.workspaces.resolve(
        (request.params as { workspaceId: string }).workspaceId,
      );
      const result = await deps.files.list(workspace.realPath, { directory, cursor, limit });
      if (result.kind === 'available') return reply.send(result.page);
      const mapped = {
        missing: [404, 'DIRECTORY_NOT_FOUND'],
        'not-directory': [409, 'DIRECTORY_NOT_DIRECTORY'],
        unreadable: [403, 'DIRECTORY_UNREADABLE'],
        'invalid-cursor': [400, 'INVALID_DIRECTORY_CURSOR'],
        'stale-cursor': [409, 'STALE_DIRECTORY_CURSOR'],
      } as const;
      const [status, code] = mapped[result.kind];
      return reply.code(status).send({ code });
    } catch (error) {
      if (error instanceof Error && error.message === 'WORKSPACE_NOT_FOUND')
        return reply.code(404).send({ code: 'WORKSPACE_NOT_FOUND' });
      return reply.code(503).send({ code: 'WORKSPACE_FILES_UNAVAILABLE' });
    }
  });
}

function parseLimit(value: unknown): number | null {
  if (value === undefined) return defaultLimit;
  if (typeof value !== 'string' || !/^(?:[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= maximumLimit ? parsed : null;
}
