/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerUpdateRestart } from './endpoint.js';

describe('POST /api/maintenance/update-restart', () => {
  it('accepts one update and restart schedule request', async () => {
    const schedule = vi.fn(async () => undefined);
    const app = fastify();
    registerUpdateRestart(app, { schedule });

    const response = await app.inject({ method: 'POST', url: '/api/maintenance/update-restart' });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
    expect(schedule).toHaveBeenCalledOnce();
    await app.close();
  });

  it('returns retryable safe guidance without exposing process output', async () => {
    const app = fastify();
    registerUpdateRestart(app, {
      schedule: async () => {
        throw new Error('secret environment and command output');
      },
    });

    const response = await app.inject({ method: 'POST', url: '/api/maintenance/update-restart' });

    expect(response.statusCode).toBe(409);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      code: 'UPDATE_RESTART_FAILED',
      retryable: true,
      detail:
        'Gestalt could not schedule the update and restart. Try again or run gestalt update-restart from a managed Mobile session.',
    });
    expect(response.body).not.toContain('secret environment');
    await app.close();
  });
});
