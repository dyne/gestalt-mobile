/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerGetCodexAllowance } from './endpoint.js';

it('returns only the read-only allowance summary without browser caching', async () => {
  const app = fastify();
  const value = { weeklyRemainingPercent: 42, weeklyResetsAt: 1_800_000_000, resetsAvailable: 2 };
  registerGetCodexAllowance(app, { read: async () => value });
  const response = await app.inject('/api/codex/allowance');
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toEqual(value);
  expect((await app.inject({ method: 'POST', url: '/api/codex/allowance' })).statusCode).toBe(404);
  await app.close();
});

it('returns a safe failure without exposing provider details', async () => {
  const app = fastify();
  registerGetCodexAllowance(app, {
    read: async () => {
      throw new Error('private account details');
    },
  });
  const response = await app.inject('/api/codex/allowance');
  expect(response.statusCode).toBe(503);
  expect(response.json().code).toBe('CODEX_ALLOWANCE_UNAVAILABLE');
  expect(response.body).not.toContain('private');
  await app.close();
});
