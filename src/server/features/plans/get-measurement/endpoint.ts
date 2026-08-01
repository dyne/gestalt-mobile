/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { PlanMeasurementSnapshot } from '../application/measurement-snapshot.js';

export function registerGetPlanMeasurement(
  app: FastifyInstance,
  deps: {
    exists(id: string): boolean;
    authorize(id: string, authorization: string | undefined): boolean;
    read(id: string): Promise<PlanMeasurementSnapshot>;
  },
): void {
  app.get('/api/sessions/:id/plan-measurement', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const authorization = typeof request.headers.authorization === 'string'
      ? request.headers.authorization
      : undefined;
    if (!deps.exists(id) || !deps.authorize(id, authorization))
      return reply.code(404).send({ code: 'SESSION_NOT_FOUND' });
    try {
      return reply.send(await deps.read(id));
    } catch {
      return reply.code(503).send({ code: 'PLAN_MEASUREMENT_UNAVAILABLE' });
    }
  });
}
