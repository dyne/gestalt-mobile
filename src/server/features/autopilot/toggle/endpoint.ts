/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type { AutopilotCoordinator } from '../application/service.js';

export function registerAutopilotToggle(
  app: FastifyInstance,
  coordinator: AutopilotCoordinator,
  idempotency?: {
    get(scope: string, key: string): { statusCode: number; body: string } | null;
    put(scope: string, key: string, statusCode: number, body: string): void;
  },
): void {
  app.put('/api/sessions/:id/autopilot', async (request, reply) => {
    const enabled = (request.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== 'boolean')
      return reply.code(400).send({ code: 'AUTOPILOT_ENABLED_REQUIRED' });
    const key = request.headers['idempotency-key'];
    const sessionId = (request.params as { id: string }).id;
    const scope = `autopilot-toggle:${sessionId}`;
    const fingerprint = createHash('sha256').update(String(enabled)).digest('hex');
    if (typeof key === 'string' && key && idempotency) {
      const prior = idempotency.get(scope, key);
      if (prior) {
        const stored = JSON.parse(prior.body) as { fingerprint?: unknown; response?: unknown };
        if (stored.fingerprint !== fingerprint)
          return reply.code(409).send({ code: 'IDEMPOTENCY_KEY_REUSED' });
        return reply.code(prior.statusCode).send(stored.response);
      }
    }
    const result = enabled ? coordinator.enable(sessionId) : coordinator.disable(sessionId);
    const statusCode = 'code' in result ? 409 : 200;
    const response = 'code' in result ? result : { autopilot: result };
    if (typeof key === 'string' && key && idempotency)
      idempotency.put(scope, key, statusCode, JSON.stringify({ fingerprint, response }));
    return reply.code(statusCode).send(response);
  });
}
