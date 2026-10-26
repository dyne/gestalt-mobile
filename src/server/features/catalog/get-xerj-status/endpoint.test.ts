/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { expect, it } from 'vitest';
import { ReadinessEvidence } from '../../../platform/retrieval/readiness-evidence.js';
import { registerXerjStatus } from './endpoint.js';
import type { XerjStatus } from '../../../../shared/contracts/xerj-status.js';
import { unknownReadiness } from '../../../../shared/contracts/retrieval-readiness.js';

it('reads current in-memory status without launching work or caching progress', async () => {
  const app = fastify();
  let current: XerjStatus = { mode: 'auto', root: '/universe', state: 'indexing', percent: 25 };
  registerXerjStatus(app, () => current);
  const initial = await app.inject('/api/xerj');
  expect(initial.statusCode).toBe(200);
  expect(initial.headers['cache-control']).toBe('no-store');
  expect(initial.json()).toEqual({ ...current, readiness: unknownReadiness() });
  current = { ...current, state: 'watching', files: 123 };
  expect((await app.inject('/api/xerj')).json()).toEqual({
    ...current,
    readiness: unknownReadiness(),
  });
  await app.close();
});

it.each(['ready', 'unknown', 'stale', 'unavailable'] as const)(
  'preserves observed %s coverage independently from connection',
  async (state) => {
    const app = fastify();
    const evidence = new ReadinessEvidence();
    evidence.connection('ready');
    evidence.coverage(state, state === 'unavailable' ? { records: 0 } : {});
    registerXerjStatus(app, () => ({
      mode: 'manual',
      state: 'ready',
      root: '/workspace',
      readiness: evidence.snapshot(),
    }));
    const result = (await app.inject('/api/xerj')).json();
    expect(result.readiness.connection.state).toBe('ready');
    expect(result.readiness.coverage.state).toBe(state);
    expect(result.readiness.coverage.observedAt).toEqual(expect.any(String));
    expect(result.readiness.coverage.generation).toEqual(expect.any(String));
    expect(result.readiness.repository).toBeNull();
    await app.close();
  },
);
