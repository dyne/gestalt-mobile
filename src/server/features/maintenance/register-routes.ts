/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { AppDependencies } from '../../app.js';
import { registerUpdateRestart } from './update-restart/endpoint.js';

export function registerMaintenanceRoutes(
  app: FastifyInstance,
  deps: Pick<AppDependencies, 'maintenance'>,
): void {
  if (deps.maintenance) registerUpdateRestart(app, deps.maintenance.updateRestart);
}
