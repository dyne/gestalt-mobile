/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerQueueTurnInput } from './endpoint.js';

describe('POST /api/sessions/:id/turns/:turnId/queue', () => {
  it('steers bounded input into the active turn with its client message id', async () => {
    const app = fastify();
    const queue = vi.fn(async () => {});
    registerQueueTurnInput(app, {
      find: () => ({ id: 'session-1', activeTurnId: 'turn-1' }) as never,
      queue,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/turns/turn-1/queue',
      headers: { 'idempotency-key': 'message-1' },
      payload: { text: '  focus on tests  ' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true, activeTurnId: 'turn-1' });
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1' }),
      'turn-1',
      'focus on tests',
      'message-1',
    );
    await app.close();
  });

  it('rejects stale turns and empty input without steering', async () => {
    const app = fastify();
    const queue = vi.fn(async () => {});
    registerQueueTurnInput(app, {
      find: () => ({ id: 'session-1', activeTurnId: 'turn-1' }) as never,
      queue,
    });
    const stale = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/turns/turn-2/queue',
      payload: { text: 'later' },
    });
    const empty = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/turns/turn-1/queue',
      payload: { text: '   ' },
    });
    expect(stale.json()).toEqual({ code: 'TURN_NOT_ACTIVE' });
    expect(empty.json()).toEqual({ code: 'TURN_INPUT_EMPTY' });
    expect(queue).not.toHaveBeenCalled();
    await app.close();
  });
});
