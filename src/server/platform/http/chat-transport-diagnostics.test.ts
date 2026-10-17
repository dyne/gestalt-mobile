/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { it, expect, vi } from 'vitest';
import { registerChatTransportDiagnostics } from './chat-transport-diagnostics.js';

it('records actual duplicate requests separately with bounded client observations, never content', async () => {
  const app = fastify();
  const record = vi.fn();
  registerChatTransportDiagnostics(app, record);
  app.get('/api/sessions/:id/history', async () => ({ text: 'private output' }));
  try {
    const options = {
      url: '/api/sessions/s/history?secret=private',
      headers: {
        'x-gestalt-history-attempts': '2',
        'x-gestalt-history-coalesced': '7',
        authorization: 'private-secret',
      },
    };
    await app.inject(options);
    await app.inject(options);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenLastCalledWith('s', {
      kind: 'history',
      status: 200,
      durationMs: expect.any(Number),
      attempts: 2,
      coalesced: 7,
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain('private');
    await app.inject({
      url: options.url,
      headers: {
        'x-gestalt-history-attempts': 'private-secret',
        'x-gestalt-history-coalesced': '9'.repeat(100),
      },
    });
    expect(record.mock.calls[2]?.[1]).not.toHaveProperty('attempts');
    expect(record.mock.calls[2]?.[1]).not.toHaveProperty('coalesced');
    record.mockImplementation(() => {
      throw Error('storage failed');
    });
    expect((await app.inject(options)).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});
