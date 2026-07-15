import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerGetHistory } from './endpoint.js';

describe('GET /api/sessions/:id/history', () => {
  it('returns normalized canonical history', async () => {
    const app = fastify();
    registerGetHistory(app, {
      find: () => ({ id: 's' }) as never,
      read: async () => ({
        turns: [
          {
            items: [{ id: 'a', type: 'agentMessage', text: 'hello', phase: 'final_answer' }],
            startedAt: 1_784_102_400,
            completedAt: 1_784_102_520,
          },
        ],
        activeTurnId: 'terminal-turn-1',
      }),
      currentSequence: () => 42,
    });
    const response = await app.inject({ method: 'GET', url: '/api/sessions/s/history' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          id: 'a',
          kind: 'agent',
          text: 'hello',
          phase: 'final_answer',
          occurredAt: 1_784_102_520_000,
        },
      ],
      activeTurnId: 'terminal-turn-1',
      currentSequence: 42,
    });
    await app.close();
  });
});
