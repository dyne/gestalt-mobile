/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerGetRetrievalReadiness } from './endpoint.js';
import { unknownReadiness } from '../../../../shared/contracts/retrieval-readiness.js';

it('validates session existence, returns current observations only on demand, and never caches', async () => {
  const app = fastify();
  const read = vi.fn(async () => ({
    connections: [{ serverName: 'gestalt-serena', readiness: unknownReadiness() }],
    repositories: [],
  }));
  registerGetRetrievalReadiness(app, { exists: (id) => id === 'known', read });
  expect(read).not.toHaveBeenCalled();
  expect((await app.inject('/api/sessions/missing/retrieval-readiness')).statusCode).toBe(404);
  expect(read).not.toHaveBeenCalled();
  const response = await app.inject('/api/sessions/known/retrieval-readiness');
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json().connections[0].readiness.symbols.state).toBe('unknown');
  expect(read).toHaveBeenCalledWith('known');
  await app.close();
});

it('keeps a released runtime unverified and bounds operation failure output', async () => {
  const app = fastify();
  const read = vi
    .fn<Parameters<typeof registerGetRetrievalReadiness>[1]['read']>()
    .mockResolvedValue(null);
  registerGetRetrievalReadiness(app, { exists: () => true, read });
  expect((await app.inject('/api/sessions/known/retrieval-readiness')).json()).toEqual({
    connections: [],
    repositories: [],
  });
  read.mockRejectedValue(new Error('private /source/path token=secret'));
  const failed = await app.inject('/api/sessions/known/retrieval-readiness');
  expect(failed.statusCode).toBe(503);
  expect(failed.json()).toEqual({ code: 'RETRIEVAL_READINESS_UNAVAILABLE' });
  await app.close();
});
