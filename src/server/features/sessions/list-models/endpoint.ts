/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ModelCatalog } from '../../catalog/application/ports.js';

const paramsSchema = z.object({ provider: z.enum(['codex', 'kimi']) });

/** Resolves the selected provider's current model catalog for new-session setup. */
export function registerListSessionModels(
  app: FastifyInstance,
  models: Pick<ModelCatalog, 'list'>,
): void {
  app.post('/api/session-models/:provider', async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ code: 'PROVIDER_INVALID' });
    return { models: await models.list(parsed.data.provider) };
  });
}
