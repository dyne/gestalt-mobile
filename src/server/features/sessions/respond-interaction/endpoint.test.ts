/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

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

  it('rejects a non-object interaction response before replying to Codex', async () => {
    const app = fastify();
    let replied = false;
    registerRespondInteraction(app, {
      exists: () => true,
      resolve: () => true,
      reply: () => {
        replied = true;
        return true;
      },
      now: () => 'now',
    });
    const result = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/interactions/request-1',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify('invalid'),
    });
    expect(result.statusCode).toBe(400);
    expect(replied).toBe(false);
    await app.close();
  });

  it('rejects a response that does not match the pending interaction kind', async () => {
    const app = fastify();
    registerRespondInteraction(app, {
      exists: () => true,
      validate: () => false,
      resolve: () => true,
      reply: () => true,
      now: () => 'now',
    });
    const result = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/interactions/request-1',
      payload: { decision: 'approved' },
    });
    expect(result.statusCode).toBe(400);
    expect(result.json()).toEqual({ code: 'INTERACTION_RESPONSE_INVALID' });
    await app.close();
  });

  it('retries a lost accepted interaction response without replying twice', async () => {
    const app = fastify();
    let replies = 0;
    let resolved = false;
    registerRespondInteraction(app, {
      exists: () => true,
      validate: () => true,
      reply: () => {
        replies++;
        return true;
      },
      resolve: () => {
        if (resolved) return false;
        resolved = true;
        return true;
      },
      alreadyResolved: () => (resolved ? { resolvedAt: 'now', outcome: 'approved' } : null),
      now: () => 'now',
    });
    const request = {
      method: 'POST' as const,
      url: '/api/sessions/session-1/interactions/request-1',
      payload: { decision: 'approved' },
    };
    expect((await app.inject(request)).statusCode).toBe(202);
    expect((await app.inject(request)).json()).toEqual({
      accepted: true,
      resolvedAt: 'now',
      outcome: 'approved',
    });
    expect(replies).toBe(1);
    await app.close();
  });

  it('replays a resolved safe outcome before the pending-only validator', async () => {
    const app = fastify();
    let replies = 0;
    let validations = 0;
    registerRespondInteraction(app, {
      exists: () => true,
      pending: () => false,
      validate: () => {
        validations++;
        return false;
      },
      alreadyResolved: () => ({ resolvedAt: 'first', outcome: 'denied' }),
      reply: () => {
        replies++;
        return true;
      },
      resolve: () => false,
      now: () => 'second',
    });
    const result = await app.inject({
      method: 'POST',
      url: '/api/sessions/s/interactions/i',
      payload: { decision: 'approved' },
    });
    expect(result.statusCode).toBe(202);
    expect(result.json()).toEqual({ accepted: true, resolvedAt: 'first', outcome: 'denied' });
    expect(validations).toBe(0);
    expect(replies).toBe(0);
    await app.close();
  });

  it('publishes only safe resolution metadata, never the submitted answer', async () => {
    const app = fastify();
    const events: unknown[] = [];
    registerRespondInteraction(app, {
      exists: () => true,
      validate: () => true,
      reply: () => true,
      resolve: () => true,
      resolved: (sessionId, requestId, occurredAt) =>
        events.push({ sessionId, requestId, occurredAt }),
      now: () => 'now',
    });
    await app.inject({
      method: 'POST',
      url: '/api/sessions/s/interactions/i',
      payload: { answer: 'secret-native-answer' },
    });
    expect(events).toEqual([{ sessionId: 's', requestId: 'i', occurredAt: 'now' }]);
    expect(JSON.stringify(events)).not.toContain('secret-native-answer');
    await app.close();
  });

  it('rejects an unknown interaction without invoking the adapter', async () => {
    const app = fastify();
    let replies = 0;
    registerRespondInteraction(app, {
      exists: () => true,
      pending: () => false,
      validate: () => true,
      reply: () => {
        replies++;
        return false;
      },
      resolve: () => false,
      now: () => 'now',
    });
    const result = await app.inject({
      method: 'POST',
      url: '/api/sessions/s/interactions/missing',
      payload: { decision: 'approved' },
    });
    expect(result.statusCode).toBe(409);
    expect(replies).toBe(0);
    await app.close();
  });
});
