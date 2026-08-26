/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { AppDependencies } from '../../app.js';
import { registerListDirectory } from './list-directory/endpoint.js';
import { registerCopyEntry } from './copy-entry/endpoint.js';
import { registerMoveEntry } from './move-entry/endpoint.js';
import { registerUploadFile } from './upload-file/endpoint.js';
import { registerDeleteEntry } from './delete-entry/endpoint.js';

export function registerFileRoutes(
  app: FastifyInstance,
  deps: Pick<AppDependencies, 'workspaceFileRoutes'>,
): void {
  if (!deps.workspaceFileRoutes) return;
  registerListDirectory(app, deps.workspaceFileRoutes);
  registerCopyEntry(app, deps.workspaceFileRoutes);
  registerMoveEntry(app, deps.workspaceFileRoutes);
  registerUploadFile(app, deps.workspaceFileRoutes);
  registerDeleteEntry(app, deps.workspaceFileRoutes);
}
