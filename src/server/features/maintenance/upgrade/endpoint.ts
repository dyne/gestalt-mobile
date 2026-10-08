/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { UpgradeStatus } from '../../../../shared/contracts/upgrade.js';
import { problem } from '../../../platform/http/problem.js';

export interface UpgradePort {
  start(): Promise<UpgradeStatus>;
  status(): Promise<UpgradeStatus>;
}

export function registerUpgrade(app: FastifyInstance, upgrade?: UpgradePort): void {
  app.get('/api/maintenance/upgrade', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!upgrade)
      return reply
        .code(503)
        .send(
          problem(
            'UPGRADE_UNAVAILABLE',
            503,
            'Start Mobile with gestalt mobile to enable upgrades.',
          ),
        );
    return upgrade.status();
  });
  app.post('/api/maintenance/upgrade', async (_request, reply) => {
    if (!upgrade)
      return reply
        .code(503)
        .send(
          problem(
            'UPGRADE_UNAVAILABLE',
            503,
            'Start Mobile with gestalt mobile to enable upgrades.',
          ),
        );
    try {
      return reply.code(202).send(await upgrade.start());
    } catch {
      return reply
        .code(503)
        .send(
          problem(
            'UPGRADE_FAILED',
            503,
            'Could not start the upgrade. Check the Gestalt manager and whether another upgrade is running.',
          ),
        );
    }
  });
}
