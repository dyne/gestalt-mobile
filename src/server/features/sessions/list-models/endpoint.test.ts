/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerListSessionModels } from './endpoint.js';

describe('POST /api/session-models/:provider', () => {
  it('resolves only the selected provider catalog', async () => {
    const app = fastify();
    const list = vi.fn(async (provider: 'codex' | 'kimi') =>
      provider === 'kimi' ? ['k2-thinking', 'kimi-k2.5'] : ['gpt-5.6-terra'],
    );
    registerListSessionModels(app, { list });

    const response = await app.inject({ method: 'POST', url: '/api/session-models/kimi' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ models: ['k2-thinking', 'kimi-k2.5'] });
    expect(list).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith('kimi');
    await app.close();
  });

  it('rejects unknown providers without querying a catalog', async () => {
    const app = fastify();
    const list = vi.fn(async () => []);
    registerListSessionModels(app, { list });

    const response = await app.inject({ method: 'POST', url: '/api/session-models/other' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'PROVIDER_INVALID' });
    expect(list).not.toHaveBeenCalled();
    await app.close();
  });
});
