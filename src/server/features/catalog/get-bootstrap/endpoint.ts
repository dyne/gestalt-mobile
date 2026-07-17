/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { getBootstrap, type BootstrapDependencies } from './use-case.js';
export function registerGetBootstrap(app: FastifyInstance, deps: BootstrapDependencies): void {
  app.get('/api/bootstrap', async () => getBootstrap(deps));
}
