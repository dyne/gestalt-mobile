/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerRefreshActivity } from './endpoint.js';

describe('POST /api/sessions/:id/activity/refresh', () => {
  it('accepts the foreground/sequence-gap reconciliation boundary and rejects unknown sessions', async () => {
    const app = fastify();
    const refresh = vi.fn(async () => undefined);
    registerRefreshActivity(app, { exists: (id) => id === 's', refresh });
    expect(
      (await app.inject({ method: 'POST', url: '/api/sessions/s/activity/refresh' })).statusCode,
    ).toBe(202);
    expect(refresh).toHaveBeenCalledWith('s');
    expect(
      (await app.inject({ method: 'POST', url: '/api/sessions/missing/activity/refresh' }))
        .statusCode,
    ).toBe(404);
    await app.close();
  });
});
