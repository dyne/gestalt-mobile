/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import { registerQuit } from './quit/endpoint.js';

export function registerMaintenanceRoutes(app: FastifyInstance): void {
  registerQuit(app);
}
