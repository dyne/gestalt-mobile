/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerInterruptTurn } from './endpoint.js';

describe('POST /api/sessions/:id/turns/:turnId/interrupt', () => {
  it('interrupts the currently active turn', async () => {
    const app = fastify();
    let interrupted = false;
    registerInterruptTurn(app, {
      find: () => ({ id: 'session-1', activeTurnId: 'turn-1' }) as never,
      interrupt: async () => {
        interrupted = true;
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/turns/turn-1/interrupt',
    });
    expect(response.statusCode).toBe(200);
    expect(interrupted).toBe(true);
    await app.close();
  });
});
