/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerStartTurn } from './endpoint.js';

describe('POST /api/sessions/:id/turns', () => {
  it('starts a text turn for a ready session', async () => {
    const app = fastify();
    const started: string[] = [];
    registerStartTurn(app, {
      find: () => ({ id: 'session-1', state: 'ready', threadId: 'thread-1' }) as never,
      start: async (_session, text) =>
        ({ id: 'session-1', state: 'turnActive', activeTurnId: 'turn-1', text }) as never,
      save: () => {},
      onStarted: (session) => {
        started.push(session.id);
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/turns',
      payload: { text: 'hello' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ id: 'session-1', activeTurnId: 'turn-1' });
    expect(started).toEqual(['session-1']);
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

  it('replays a lost accepted response and invokes the turn adapter once', async () => {
    const app = fastify();
    const results = new Map<string, { statusCode: number; body: string }>();
    let starts = 0;
    const clientMessageIds: Array<string | undefined> = [];
    registerStartTurn(app, {
      find: () => ({ id: 'session-1', state: 'ready' }) as never,
      start: async (_session, _text, clientUserMessageId) => {
        starts++;
        clientMessageIds.push(clientUserMessageId);
        return { id: 'session-1', activeTurnId: 'turn-1' } as never;
      },
      save: () => {},
      idempotency: {
        get: (scope, key) => results.get(`${scope}:${key}`) ?? null,
        put: (scope, key, statusCode, body) => results.set(`${scope}:${key}`, { statusCode, body }),
      },
    });
    const request = {
      method: 'POST' as const,
      url: '/api/sessions/session-1/turns',
      headers: { 'idempotency-key': 'lost-response' },
      payload: { text: 'hello' },
    };
    expect((await app.inject(request)).statusCode).toBe(202);
    expect((await app.inject(request)).json()).toMatchObject({ activeTurnId: 'turn-1' });
    expect(starts).toBe(1);
    expect(clientMessageIds).toEqual(['lost-response']);
    await app.close();
  });

  it('publishes turn-adjacent interaction state before the HTTP turn response', async () => {
    const app = fastify();
    const order: string[] = [];
    registerStartTurn(app, {
      find: () => ({ id: 'session-1', state: 'ready' }) as never,
      start: async () => ({ id: 'session-1', activeTurnId: 'turn-1' }) as never,
      save: () => order.push('saved'),
      onStarted: () => order.push('interaction-visible'),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/turns',
      payload: { text: 'hello' },
    });
    expect(response.statusCode).toBe(202);
    expect(order).toEqual(['saved', 'interaction-visible']);
    await app.close();
  });

  it('rejects a retry key reused for a different prompt and isolates session scopes', async () => {
    const app = fastify();
    const results = new Map<string, { statusCode: number; body: string }>();
    let starts = 0;
    registerStartTurn(app, {
      find: (id) => ({ id, state: 'ready' }) as never,
      start: async (session) => {
        starts++;
        return { id: session.id, activeTurnId: `turn-${starts}` } as never;
      },
      save: () => {},
      idempotency: {
        get: (scope, key) => results.get(`${scope}:${key}`) ?? null,
        put: (scope, key, statusCode, body) => results.set(`${scope}:${key}`, { statusCode, body }),
      },
    });
    const request = (id: string, text: string) => ({
      method: 'POST' as const,
      url: `/api/sessions/${id}/turns`,
      headers: { 'idempotency-key': 'same-key' },
      payload: { text },
    });
    expect((await app.inject(request('a', 'one'))).statusCode).toBe(202);
    expect((await app.inject(request('a', 'different'))).json()).toEqual({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect((await app.inject(request('b', 'different'))).statusCode).toBe(202);
    expect(starts).toBe(2);
    await app.close();
  });

  it('coalesces simultaneous duplicate turn starts into one adapter invocation', async () => {
    const app = fastify();
    const results = new Map<string, { statusCode: number; body: string }>();
    let starts = 0;
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    registerStartTurn(app, {
      find: () => ({ id: 's', state: 'ready' }) as never,
      start: async () => {
        starts++;
        entered();
        await pending;
        return { id: 's', activeTurnId: 'turn' } as never;
      },
      save: () => {},
      idempotency: {
        get: (scope, key) => results.get(`${scope}:${key}`) ?? null,
        put: (scope, key, statusCode, body) => results.set(`${scope}:${key}`, { statusCode, body }),
      },
    });
    const request = {
      method: 'POST' as const,
      url: '/api/sessions/s/turns',
      headers: { 'idempotency-key': 'k' },
      payload: { text: 'one' },
    };
    const first = app.inject(request);
    const second = app.inject(request);
    await started;
    expect(starts).toBe(1);
    release();
    expect((await first).statusCode).toBe(202);
    expect((await second).statusCode).toBe(202);
    expect(starts).toBe(1);
    await app.close();
  });
});
