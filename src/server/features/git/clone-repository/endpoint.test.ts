/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerCloneRepository } from './endpoint.js';

describe('POST /api/git/clone', () => {
  it('clones a supplied Git address into the workspace root', async () => {
    const app = fastify();
    let address = '';
    registerCloneRepository(app, { clone: async (value) => void (address = value) });

    const response = await app.inject({
      method: 'POST',
      url: '/api/git/clone',
      payload: { address: 'https://example.test/gestalt.git' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
    expect(address).toBe('https://example.test/gestalt.git');
    await app.close();
  });

  it('rejects an empty Git address', async () => {
    const app = fastify();
    let called = false;
    registerCloneRepository(app, { clone: async () => void (called = true) });

    const response = await app.inject({ method: 'POST', url: '/api/git/clone', payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'INVALID_CLONE_ADDRESS' });
    expect(called).toBe(false);
    await app.close();
  });
});
