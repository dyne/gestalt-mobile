/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { AppDependencies } from '../../app.js';
import { registerListDirectory } from './list-directory/endpoint.js';

export function registerFileRoutes(
  app: FastifyInstance,
  deps: Pick<AppDependencies, 'workspaceFileRoutes'>,
): void {
  if (deps.workspaceFileRoutes) registerListDirectory(app, deps.workspaceFileRoutes);
}
