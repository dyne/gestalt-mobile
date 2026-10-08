/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import { registerQuit } from './quit/endpoint.js';
import { registerUpgrade, type UpgradePort } from './upgrade/endpoint.js';

export function registerMaintenanceRoutes(app: FastifyInstance, upgrade?: UpgradePort): void {
  registerQuit(app);
  registerUpgrade(app, upgrade);
}
