/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from 'fastify';
import type { WorkspaceCatalog } from '../../catalog/application/ports.js';
import type { WorkspaceFileSource } from '../application/ports.js';
import { mutation } from '../copy-entry/endpoint.js';
export function registerMoveEntry(
  app: FastifyInstance,
  deps: { workspaces: Pick<WorkspaceCatalog, 'resolve'>; files: WorkspaceFileSource },
): void {
  app.post('/api/workspaces/:workspaceId/files/move', async (request, reply) =>
    mutation(request, reply, deps, 'move'),
  );
}
