/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { AutopilotCoordinator } from '../application/service.js';

export function registerAutopilotToggle(
  app: FastifyInstance,
  coordinator: AutopilotCoordinator,
): void {
  app.put('/api/sessions/:id/autopilot', async (request, reply) => {
    const enabled = (request.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== 'boolean')
      return reply.code(400).send({ code: 'AUTOPILOT_ENABLED_REQUIRED' });
    const result = enabled
      ? coordinator.enable((request.params as { id: string }).id)
      : coordinator.disable((request.params as { id: string }).id);
    return 'code' in result ? reply.code(409).send(result) : reply.send({ autopilot: result });
  });
}
