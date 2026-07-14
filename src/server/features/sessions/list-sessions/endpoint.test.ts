import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerListSessions } from './endpoint.js';

describe('GET /api/sessions', () => {
  it('returns durable relay sessions', async () => {
    const app = fastify();
    registerListSessions(app, { list: () => [{ id: 'session-1', state: 'ready' }] as never });
    const response = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ id: 'session-1', state: 'ready' }]);
    await app.close();
  });
});
