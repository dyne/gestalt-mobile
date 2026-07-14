import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerStopSession } from './endpoint.js';

describe('POST /api/sessions/:id/stop', () => {
  it('persists a stopped session and closes its app-server process', async () => {
    const app = fastify();
    let closed = false;
    registerStopSession(app, {
      find: () => ({ id: 'session-1', state: 'ready' }) as never,
      stop: (session) => ({ ...session, state: 'stopped' }) as never,
      save: () => {},
      close: () => {
        closed = true;
      },
    });
    const response = await app.inject({ method: 'POST', url: '/api/sessions/session-1/stop' });
    expect(response.statusCode).toBe(202);
    expect(closed).toBe(true);
    await app.close();
  });
});
