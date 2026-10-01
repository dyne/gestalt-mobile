/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

export function registerQuit(app: FastifyInstance): void {
  app.post('/api/maintenance/quit', async (_request, reply) => {
    reply.raw.once('finish', () => {
      void app.close().catch(() => {
        app.log.error('Gestalt Mobile failed to quit cleanly');
      });
    });
    return reply.code(202).send({ accepted: true });
  });
}
