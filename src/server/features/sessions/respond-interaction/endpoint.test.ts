import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerRespondInteraction } from './endpoint.js';

describe('POST /api/sessions/:id/interactions/:requestId', () => {
  it('resolves a pending interaction exactly once', async () => {
    const app = fastify();
    let response: unknown;
    registerRespondInteraction(app, {
      exists: () => true,
      resolve: () => true,
      reply: (_sessionId, _requestId, value) => {
        response = value;
        return true;
      },
      now: () => 'now',
    });
    const result = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/interactions/request-1',
      payload: { decision: 'approved' },
    });
    expect(result.statusCode).toBe(202);
    expect(response).toEqual({ decision: 'approved' });
    await app.close();
  });
});
