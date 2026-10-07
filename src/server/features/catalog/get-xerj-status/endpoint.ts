/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { XerjStatus } from '../../../../shared/contracts/xerj-status.js';

export function registerXerjStatus(app: FastifyInstance, status: () => XerjStatus): void {
  app.get('/api/xerj', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return status();
  });
}
