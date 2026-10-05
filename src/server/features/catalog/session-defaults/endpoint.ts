/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import {
  sessionDefaultsSchema,
  type SessionDefaultsStore,
} from '../../../../shared/contracts/session-defaults.js';

export function registerSessionDefaults(app: FastifyInstance, store: SessionDefaultsStore): void {
  app.get('/api/session-defaults', async () => ({ defaults: await store.read() }));
  app.put('/api/session-defaults', async (request, reply) => {
    const parsed = sessionDefaultsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_SESSION_DEFAULTS' });
    await store.save(parsed.data);
    return { defaults: parsed.data };
  });
}
