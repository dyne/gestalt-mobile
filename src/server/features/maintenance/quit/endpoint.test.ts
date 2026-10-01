/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerQuit } from './endpoint.js';

describe('POST /api/maintenance/quit', () => {
  it('accepts the request before closing the relay through its graceful shutdown path', async () => {
    const app = fastify();
    const close = vi.spyOn(app, 'close').mockResolvedValue(undefined);
    registerQuit(app);

    const response = await app.inject({ method: 'POST', url: '/api/maintenance/quit' });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
});
