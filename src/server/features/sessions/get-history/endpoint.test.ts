import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerGetHistory } from './endpoint.js';

describe('GET /api/sessions/:id/history', () => {
  it('returns normalized canonical history', async () => {
    const app = fastify();
    registerGetHistory(app, {
      find: () => ({ id: 's' }) as never,
      read: async () => [{ id: 'a', type: 'agentMessage', text: 'hello', phase: 'final' }],
    });
    const response = await app.inject({ method: 'GET', url: '/api/sessions/s/history' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [{ id: 'a', kind: 'agent', text: 'hello', phase: 'final_answer' }],
    });
    await app.close();
  });
});
