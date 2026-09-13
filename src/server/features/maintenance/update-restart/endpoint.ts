/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import { problem } from '../../../platform/http/problem.js';
import type { UpdateRestartScheduler } from '../application/ports.js';

export function registerUpdateRestart(
  app: FastifyInstance,
  scheduler: UpdateRestartScheduler,
): void {
  app.post('/api/maintenance/update-restart', async (_request, reply) => {
    try {
      await scheduler.schedule();
      return reply.code(202).send({ accepted: true });
    } catch {
      return reply
        .code(409)
        .type('application/problem+json')
        .send(
          problem(
            'UPDATE_RESTART_FAILED',
            409,
            'Gestalt could not schedule the update and restart. Try again or run gestalt update-restart from a managed Mobile session.',
            true,
          ),
        );
    }
  });
}
