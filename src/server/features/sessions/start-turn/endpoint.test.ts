import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerStartTurn } from './endpoint.js';

describe('POST /api/sessions/:id/turns', () => {
  it('starts a text turn for a ready session', async () => {
    const app = fastify();
    registerStartTurn(app, {
      find: () => ({ id: 'session-1', state: 'ready', threadId: 'thread-1' }) as never,
      start: async (_session, text) =>
        ({ id: 'session-1', state: 'turnActive', activeTurnId: 'turn-1', text }) as never,
      save: () => {},
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/turns',
      payload: { text: 'hello' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ id: 'session-1', activeTurnId: 'turn-1' });
    await app.close();
  });

  it('rejects a turn larger than the relay input limit', async () => {
    const app = fastify();
    registerStartTurn(app, {
      find: () => ({ id: 'session-1', state: 'ready', threadId: 'thread-1' }) as never,
      start: async () => ({}) as never,
      save: () => {},
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/turns',
      payload: { text: 'x'.repeat(100_001) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'TURN_INPUT_TOO_LONG' });
    await app.close();
  });
});
