/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerXerjStatus } from './endpoint.js';
import type { XerjStatus } from '../../../../shared/contracts/xerj-status.js';

it('reads current in-memory status without launching work or caching progress', async () => {
  const app = fastify();
  let current: XerjStatus = { mode: 'auto', root: '/universe', state: 'indexing', percent: 25 };
  registerXerjStatus(app, () => current);
  const initial = await app.inject('/api/xerj');
  expect(initial.statusCode).toBe(200);
  expect(initial.headers['cache-control']).toBe('no-store');
  expect(initial.json()).toEqual(current);
  current = { ...current, state: 'watching', files: 123 };
  expect((await app.inject('/api/xerj')).json()).toEqual(current);
  await app.close();
});
