/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { SessionDefaultsStore } from '../../../shared/contracts/session-defaults.js';
import type { BootstrapDependencies } from './get-bootstrap/use-case.js';
import { registerXerjStatus } from './get-xerj-status/endpoint.js';
import { registerGetBootstrap } from './get-bootstrap/endpoint.js';
import { registerSessionDefaults } from './session-defaults/endpoint.js';

export function registerCatalogRoutes(
  app: FastifyInstance,
  deps: {
    bootstrap?: BootstrapDependencies;
    sessionDefaults?: SessionDefaultsStore;
  },
): void {
  if (deps.bootstrap) registerGetBootstrap(app, deps.bootstrap);
  if (deps.bootstrap?.xerj) registerXerjStatus(app, deps.bootstrap.xerj);
  if (deps.sessionDefaults) registerSessionDefaults(app, deps.sessionDefaults);
}
