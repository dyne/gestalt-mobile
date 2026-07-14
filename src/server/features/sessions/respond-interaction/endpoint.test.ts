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

  it('keeps the interaction pending when the app-server cannot accept a response', async () => {
    const app = fastify();
    let resolved = false;
    registerRespondInteraction(app, {
      exists: () => true,
      resolve: () => {
        resolved = true;
        return true;
      },
      reply: () => false,
      now: () => 'now',
    });

    const result = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/interactions/request-1',
      payload: { decision: 'approved' },
    });

    expect(result.statusCode).toBe(409);
    expect(resolved).toBe(false);
    await app.close();
  });

  it('publishes an interaction resolution after durable resolution', async () => {
    const app = fastify();
    const completed: unknown[] = [];
    registerRespondInteraction(app, {
      exists: () => true,
      resolve: () => true,
      reply: () => true,
      resolved: (sessionId, requestId, occurredAt) =>
        completed.push({ sessionId, requestId, occurredAt }),
      now: () => 'now',
    });

    await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/interactions/request-1',
      payload: { decision: 'approved' },
    });

    expect(completed).toEqual([
      { sessionId: 'session-1', requestId: 'request-1', occurredAt: 'now' },
    ]);
    await app.close();
  });
});
