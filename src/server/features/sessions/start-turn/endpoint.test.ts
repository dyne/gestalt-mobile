/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerStartTurn } from './endpoint.js';
import { WriterAcquisitionError } from '../application/writer-acquisition.js';
import { writerAcquisitionProblem } from '../application/writer-acquisition.js';

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

  it('acquires a detached writer once, persists ready, then forwards the original key', async () => {
    const app = fastify();
    const order: string[] = [];
    registerStartTurn(app, {
      find: () => ({ id: 's', state: 'stopped', threadId: 'thread-1' }) as never,
      ensureWriter: async () => {
        order.push('resume');
        return {
          session: { id: 's', state: 'ready', threadId: 'thread-1' } as never,
          replacementCreated: false,
        };
      },
      start: async (_session, _text, key) => {
        order.push(`start:${key}`);
        return { id: 's', state: 'turnActive', activeTurnId: 'turn-1' } as never;
      },
      save: (session) => order.push(`save:${session.state}`),
      idempotency: { get: () => null, put: () => {} },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/s/turns',
      headers: { 'idempotency-key': 'client-1' },
      payload: { text: 'hello' },
    });
    expect(response.statusCode).toBe(202);
    expect(order).toEqual(['resume', 'save:ready', 'start:client-1', 'save:turnActive']);
    await app.close();
  });

  it('returns a safe retryable writer-busy problem without starting or caching a turn', async () => {
    const app = fastify();
    let starts = 0;
    let cached = 0;
    registerStartTurn(app, {
      find: () => ({ id: 's', state: 'stopped', threadId: 'thread-secret' }) as never,
      ensureWriter: async () => {
        throw new WriterAcquisitionError('writerBusy');
      },
      start: async () => {
        starts++;
        return {} as never;
      },
      save: () => {},
      idempotency: {
        get: () => null,
        put: () => {
          cached++;
        },
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/s/turns',
      headers: { 'idempotency-key': 'k' },
      payload: { text: 'hello' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      status: 409,
      code: 'SESSION_WRITER_BUSY',
      retryable: true,
      detail: 'This thread is active in another Codex client. Release it there, then retry.',
    });
    expect(response.body).not.toContain('thread-secret');
    expect(starts).toBe(0);
    expect(cached).toBe(0);
    await app.close();
  });

  it('rejects an already active turn without acquiring or starting again', async () => {
    const app = fastify();
    let acquired = 0;
    let started = 0;
    registerStartTurn(app, {
      find: () => ({ id: 's', state: 'turnActive', threadId: 'thread-1' }) as never,
      ensureWriter: async () => {
        acquired++;
        return {} as never;
      },
      start: async () => {
        started++;
        return {} as never;
      },
      save: () => {},
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/s/turns',
      payload: { text: 'hello' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: 'SESSION_TURN_ACTIVE' });
    expect(acquired).toBe(0);
    expect(started).toBe(0);
    await app.close();
  });

  it.each([
    ['rolloutMissing', 409, 'SESSION_ROLLOUT_MISSING', false],
    ['workspaceUnavailable', 409, 'SESSION_WORKSPACE_UNAVAILABLE', true],
    ['runtimeDependencyFailed', 502, 'SESSION_RUNTIME_DEPENDENCY_FAILED', true],
    ['protocolIncompatible', 503, 'CODEX_PROTOCOL_INCOMPATIBLE', false],
    ['runtimeUnavailable', 503, 'SESSION_RUNTIME_UNAVAILABLE', true],
  ] as const)('maps %s to a stable redacted problem', async (kind, status, code, retryable) => {
    const app = fastify();
    registerStartTurn(app, {
      find: () => ({ id: 's', state: 'stopped', threadId: 'private-thread-id' }) as never,
      ensureWriter: async () => {
        throw new WriterAcquisitionError(kind);
      },
      start: async () => ({}) as never,
      save: () => {},
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/s/turns',
      payload: { text: 'hello' },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ status, code, retryable });
    expect(response.body).not.toContain('private-thread-id');
    await app.close();
  });

  it('falls back to the redacted runtime-unavailable problem for unknown failures', async () => {
    const app = fastify();
    registerStartTurn(app, {
      find: () => ({ id: 's', state: 'stopped', threadId: 'private-thread-id' }) as never,
      ensureWriter: async () => {
        throw new Error('raw codex failure private-thread-id');
      },
      start: async () => ({}) as never,
      save: () => {},
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/s/turns',
      payload: { text: 'hello' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(writerAcquisitionProblem('runtimeUnavailable'));
    expect(response.body).not.toContain('private-thread-id');
    await app.close();
  });

  it('releases an acquired writer when post-start persistence fails without masking the failure', async () => {
    const app = fastify();
    const original = {
      id: 's',
      state: 'stopped',
      threadId: 'thread-1',
      pendingInteractions: [],
    };
    const acquired = { ...original, state: 'ready' };
    let releases = 0;
    let saves = 0;
    registerStartTurn(app, {
      find: () => original as never,
      ensureWriter: async () => ({ session: acquired as never, replacementCreated: false }),
      start: async () => ({ ...acquired, state: 'turnActive', activeTurnId: 'turn-1' }) as never,
      save: () => {
        if (++saves > 1) throw new Error('persistence failure');
      },
      releaseWriter: async () => {
        releases++;
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/s/turns',
      payload: { text: 'hello' },
    });
    expect(response.statusCode).toBe(500);
    expect(releases).toBe(1);
    await app.close();
  });
});
