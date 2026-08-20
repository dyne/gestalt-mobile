/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerAutopilotToggle } from './endpoint.js';

describe('autopilot toggle endpoint', () => {
  it('uses typed safe conflicts and rejects malformed enabled values', async () => {
    const app = fastify();
    registerAutopilotToggle(app, {
      enable: () => ({ code: 'AUTOPILOT_PLAN_REQUIRED' }),
      disable: () => ({
        state: 'disabled',
        enabled: false,
        retry: { position: 0, limit: 3 },
        updatedAt: 't',
      }),
    } as never);
    expect(
      (await app.inject({ method: 'PUT', url: '/api/sessions/s/autopilot', payload: {} }))
        .statusCode,
    ).toBe(400);
    const conflict = await app.inject({
      method: 'PUT',
      url: '/api/sessions/s/autopilot',
      payload: { enabled: true },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ code: 'AUTOPILOT_PLAN_REQUIRED' });
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/sessions/s/autopilot',
          payload: { enabled: false },
        })
      ).json(),
    ).toMatchObject({ autopilot: { enabled: false } });
    await app.close();
  });
});
