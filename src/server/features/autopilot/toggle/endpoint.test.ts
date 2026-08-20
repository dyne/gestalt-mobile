/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
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

  it('replays an idempotent toggle and rejects a stale key with another operation', async () => {
    const app = fastify();
    const entries = new Map<string, { statusCode: number; body: string }>();
    const enable = vi.fn(() => ({
      state: 'monitoring',
      enabled: true,
      retry: { position: 0, limit: 3 },
      updatedAt: 't',
    }));
    registerAutopilotToggle(
      app,
      {
        enable,
        disable: () => ({
          state: 'disabled',
          enabled: false,
          retry: { position: 0, limit: 3 },
          updatedAt: 't',
        }),
      } as never,
      {
        get: (scope, key) => entries.get(`${scope}:${key}`) ?? null,
        put: (scope, key, statusCode, body) => entries.set(`${scope}:${key}`, { statusCode, body }),
      },
    );
    const first = await app.inject({
      method: 'PUT',
      url: '/api/sessions/s/autopilot',
      headers: { 'idempotency-key': 'same' },
      payload: { enabled: true },
    });
    const replay = await app.inject({
      method: 'PUT',
      url: '/api/sessions/s/autopilot',
      headers: { 'idempotency-key': 'same' },
      payload: { enabled: true },
    });
    const conflict = await app.inject({
      method: 'PUT',
      url: '/api/sessions/s/autopilot',
      headers: { 'idempotency-key': 'same' },
      payload: { enabled: false },
    });
    expect(first.json()).toEqual(replay.json());
    expect(enable).toHaveBeenCalledOnce();
    expect(conflict).toMatchObject({ statusCode: 409 });
    await app.close();
  });

  it('deduplicates simultaneous same-key toggle requests', async () => {
    const app = fastify();
    const entries = new Map<string, { statusCode: number; body: string }>();
    const enable = vi.fn(() => ({
      state: 'monitoring',
      enabled: true,
      retry: { position: 0, limit: 3 },
      updatedAt: 't',
    }));
    registerAutopilotToggle(app, { enable, disable: vi.fn() } as never, {
      get: (scope, key) => entries.get(`${scope}:${key}`) ?? null,
      put: (scope, key, statusCode, body) => entries.set(`${scope}:${key}`, { statusCode, body }),
    });
    const requests = await Promise.all(
      Array.from({ length: 2 }, () =>
        app.inject({
          method: 'PUT',
          url: '/api/sessions/s/autopilot',
          headers: { 'idempotency-key': 'concurrent' },
          payload: { enabled: true },
        }),
      ),
    );
    expect(requests.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(enable).toHaveBeenCalledOnce();
    await app.close();
  });
});
