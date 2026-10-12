/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { PreviewGrantDependencies } from './application/ports.js';
import { registerLaunchGrant } from './launch/endpoint.js';
import { registerRenewLease } from './renew/endpoint.js';
import { registerLiveGrantStatus } from './status/endpoint.js';
import { registerLiveHttpBoundary } from './http/boundary.js';

/** Mobile routes only; preview endpoints belong to the separately bound private gateway. */
export function registerLiveDesignRoutes(
  app: FastifyInstance,
  deps: PreviewGrantDependencies,
): void {
  app.register(async (scope) => {
    registerLiveHttpBoundary(scope);
    registerLaunchGrant(scope, deps);
    registerRenewLease(scope, deps);
    registerLiveGrantStatus(scope, deps);
  });
}
