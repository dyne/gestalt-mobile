/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerUpgrade } from './endpoint.js';

describe('maintenance upgrade', () => {
  it('accepts an upgrade without closing the relay and exposes uncached progress', async () => {
    const app = fastify();
    const snapshot = { instanceId: 'old', phase: 'updating' as const };
    const port = { start: vi.fn(async () => snapshot), status: vi.fn(async () => snapshot) };
    registerUpgrade(app, port);
    const close = vi.spyOn(app, 'close');
    const response = await app.inject({
      method: 'POST',
      url: '/api/maintenance/upgrade',
      payload: { command: 'ignored' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(snapshot);
    expect(port.start).toHaveBeenCalledWith();
    expect(close).not.toHaveBeenCalled();
    const status = await app.inject('/api/maintenance/upgrade');
    expect(status.json()).toEqual(snapshot);
    expect(status.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('reports scheduling failures without leaking command output', async () => {
    const app = fastify();
    registerUpgrade(app, {
      start: async () => {
        throw new Error('private output');
      },
      status: async () => ({ instanceId: 'old', phase: 'idle' }),
    });
    const response = await app.inject({ method: 'POST', url: '/api/maintenance/upgrade' });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('UPGRADE_FAILED');
    expect(response.body).not.toContain('private output');
    await app.close();
  });

  it('reports an unavailable upgrade adapter', async () => {
    const app = fastify();
    registerUpgrade(app);
    expect((await app.inject({ method: 'POST', url: '/api/maintenance/upgrade' })).statusCode).toBe(
      503,
    );
    await app.close();
  });
});
