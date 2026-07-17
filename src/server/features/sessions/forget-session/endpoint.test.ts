/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerForgetSession } from './endpoint.js';

describe('DELETE /api/sessions/:id', () => {
  it('closes the relay runtime and removes only the managed session record', async () => {
    const app = fastify();
    const calls: string[] = [];
    registerForgetSession(app, {
      find: () => ({ id: 'session-1' }) as never,
      close: () => calls.push('close'),
      remove: () => calls.push('remove'),
    });

    expect(
      (await app.inject({ method: 'DELETE', url: '/api/sessions/session-1' })).statusCode,
    ).toBe(204);
    expect(calls).toEqual(['close', 'remove']);
    await app.close();
  });
});
