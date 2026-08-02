/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerRestoreSession } from './endpoint.js';
import { CodexJsonRpcError, isMissingCodexThreadRollout } from '../../../platform/codex/json-rpc-client.js';
import { CodexSessionRuntime } from '../../../platform/codex/session-runtime.js';

describe('POST /api/sessions/:id/restore', () => {
  it('restores a resumable session and persists its ready state', async () => {
    const app = fastify();
    let saved = false;
    registerRestoreSession(app, {
      find: () => ({ id: 'session-1', threadId: 'thread-1', state: 'stopped' }) as never,
      restore: async () => ({ id: 'session-1', state: 'ready' }) as never,
      save: () => {
        saved = true;
      },
    });
    const response = await app.inject({ method: 'POST', url: '/api/sessions/session-1/restore' });
    expect(response.statusCode).toBe(200);
    expect(saved).toBe(true);
    await app.close();
  });

  it('rejects restore when the relay already owns the thread', async () => {
    const app = fastify();
    let restored = false;
    registerRestoreSession(app, {
      find: () => ({ id: 'session-1', threadId: 'thread-1', state: 'ready' }) as never,
      restore: async () => {
        restored = true;
        return {} as never;
      },
      save: () => {},
    });

    const response = await app.inject({ method: 'POST', url: '/api/sessions/session-1/restore' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: 'SESSION_CANNOT_RESTORE' });
    expect(restored).toBe(false);
    await app.close();
  });

  it('replays a restore response without launching another runtime', async () => {
    const app = fastify();
    const responses = new Map<string, string>();
    let restores = 0;
    registerRestoreSession(app, {
      find: () => ({ id: 'session-1', threadId: 'thread-1', state: 'stopped' }) as never,
      restore: async () => {
        restores += 1;
        return { id: 'session-1', state: 'ready' } as never;
      },
      save: () => {},
      idempotency: {
        get: (_scope, key) =>
          responses.has(key) ? { statusCode: 200, body: responses.get(key)! } : null,
        put: (_scope, key, _statusCode, body) => responses.set(key, body),
      },
    });
    const request = {
      method: 'POST' as const,
      url: '/api/sessions/session-1/restore',
      headers: { 'idempotency-key': 'restore-retry' },
    };

    await app.inject(request);
    await app.inject(request);

    expect(restores).toBe(1);
    await app.close();
  });

  it('reproduces missing-rollout resume through Open without classifying other RPC errors', async () => {
    const app = fastify();
    const calls: string[] = [];
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) => {
          calls.push(method);
          if (method === 'thread/resume')
            throw new CodexJsonRpcError(-32600, 'no rollout found for thread id old-thread');
          return {};
        },
        onNotification: () => () => {}, onServerRequest: () => () => {},
      }, close: () => {},
    }));
    let classified = false;
    app.setErrorHandler((error, _request, reply) => {
      classified = isMissingCodexThreadRollout(error);
      return reply.code(502).send({ code: 'RESTORE_FAILED' });
    });
    registerRestoreSession(app, {
      find: () => ({ id: 'session-1', workspaceId: 'workspace-1', workspacePath: '/workspace', profile: 'default', threadId: 'old-thread', state: 'released', desiredState: 'stopped', activeTurnId: null, protocolVersion: null, failureCount: 0, pendingInteractions: [], createdAt: 'before', updatedAt: 'before' }),
      restore: (session) => runtime.restore(session, 'after'), save: () => {},
    });
    const response = await app.inject({ method: 'POST', url: '/api/sessions/session-1/restore' });
    expect(response.statusCode).toBe(502);
    expect(calls).toEqual(['initialize', 'thread/resume']);
    expect(classified).toBe(true);
    expect(isMissingCodexThreadRollout(new CodexJsonRpcError(-32600, 'invalid parameters'))).toBe(false);
    await app.close();
  });
});
