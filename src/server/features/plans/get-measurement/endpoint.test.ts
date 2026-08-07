/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerGetPlanMeasurement } from './endpoint.js';

describe('GET /api/sessions/:id/plan-measurement', () => {
  it('returns only the bearer-authorized session measurement', async () => {
    const app = fastify();
    registerGetPlanMeasurement(app, {
      exists: (id) => id === 'one' || id === 'two',
      authorize: (id, authorization) => authorization === `Bearer token-${id}`,
      read: async (id) => ({
        capturedAt: '2026-08-01T12:00:00Z',
        weeklyRemainingPercent: id === 'one' ? 70 : 30,
        threadTokens: 42,
      }),
    });

    expect(
      (
        await app.inject({
          url: '/api/sessions/one/plan-measurement',
          headers: { authorization: 'Bearer token-one' },
        })
      ).json(),
    ).toMatchObject({ weeklyRemainingPercent: 70, threadTokens: 42 });
    expect(
      (
        await app.inject({
          url: '/api/sessions/two/plan-measurement',
          headers: { authorization: 'Bearer token-one' },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });

  it('returns unavailable when the session app-server cannot supply a snapshot', async () => {
    const app = fastify();
    registerGetPlanMeasurement(app, {
      exists: () => true,
      authorize: () => true,
      read: async () => {
        throw new Error('unavailable');
      },
    });
    const response = await app.inject('/api/sessions/one/plan-measurement');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: 'PLAN_MEASUREMENT_UNAVAILABLE' });
    await app.close();
  });
});
