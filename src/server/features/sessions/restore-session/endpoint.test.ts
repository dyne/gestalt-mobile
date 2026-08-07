/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerRestoreSession } from './endpoint.js';
import {
  CodexJsonRpcError,
  isMissingCodexThreadRollout,
} from '../../../platform/codex/json-rpc-client.js';
import { CodexSessionRuntime } from '../../../platform/codex/session-runtime.js';
import type { RelaySessionSnapshot } from '../model/relay-session.js';

describe('POST /api/sessions/:id/restore', () => {
  it('restores a resumable session and persists its ready state', async () => {
    const app = fastify();
    let saved = false;
    registerRestoreSession(app, {
      find: () => persistedSession('stopped'),
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
      find: () => persistedSession('stopped'),
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

  it('recreates and persists a replacement for a missing rollout through Open', async () => {
    const app = fastify();
    const calls: string[] = [];
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) => {
          calls.push(method);
          if (method === 'thread/resume')
            throw new CodexJsonRpcError(-32600, 'no rollout found for thread id old-thread');
          if (method === 'thread/start') return { thread: { id: 'replacement-thread' } };
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    const saved: unknown[] = [];
    registerRestoreSession(app, {
      find: () => ({
        id: 'session-1',
        workspaceId: 'workspace-1',
        workspacePath: '/workspace',
        profile: 'default',
        threadId: 'old-thread',
        state: 'released',
        desiredState: 'stopped',
        activeTurnId: null,
        protocolVersion: null,
        failureCount: 0,
        pendingInteractions: [],
        createdAt: 'before',
        updatedAt: 'before',
      }),
      restore: (session) => runtime.restore(session, 'after'),
      save: (session) => saved.push(session),
    });
    const response = await app.inject({ method: 'POST', url: '/api/sessions/session-1/restore' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'ready', threadId: 'replacement-thread' });
    expect(calls).toEqual(['initialize', 'thread/resume', 'thread/start']);
    expect(saved).toMatchObject([
      { state: 'recovering', threadId: 'old-thread' },
      { state: 'ready', threadId: 'replacement-thread' },
    ]);
    expect(isMissingCodexThreadRollout(new CodexJsonRpcError(-32600, 'invalid parameters'))).toBe(
      false,
    );
    await app.close();
  });

  it('returns a bounded restore failure without exposing app-server details', async () => {
    const app = fastify();
    const saved: unknown[] = [];
    registerRestoreSession(app, {
      find: () => persistedSession('stopped'),
      restore: async () => {
        throw new Error('authentication failed: secret-token');
      },
      save: (session) => saved.push(session),
    });
    const response = await app.inject({ method: 'POST', url: '/api/sessions/session-1/restore' });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ code: 'RESTORE_FAILED' });
    expect(response.body).not.toContain('secret-token');
    expect(saved).toMatchObject([
      { state: 'recovering', threadId: 'thread-1' },
      { state: 'stopped', threadId: 'thread-1' },
    ]);
    await app.close();
  });

  it('keeps generic failures retryable with their original metadata and permits a later Open', async () => {
    const app = fastify();
    let durable: RelaySessionSnapshot = {
      ...persistedSession('released'),
      model: 'gpt-5.4',
      branch: 'main',
      effectiveSkillSelection: { selectedProfileName: 'focused', skills: [] },
      lastOrgPlan: { filename: 'plan.org', title: 'Plan' },
    };
    let attempts = 0;
    registerRestoreSession(app, {
      find: () => durable,
      restore: async (session) => {
        attempts += 1;
        if (attempts === 1) throw new CodexJsonRpcError(-32600, 'invalid parameters');
        return { ...session, state: 'ready' } as never;
      },
      save: (session) => {
        durable = session;
      },
    });

    const failed = await app.inject({ method: 'POST', url: '/api/sessions/session-1/restore' });
    expect(failed.statusCode).toBe(502);
    expect(durable).toMatchObject({
      state: 'released',
      threadId: 'thread-1',
      model: 'gpt-5.4',
      branch: 'main',
      effectiveSkillSelection: { selectedProfileName: 'focused' },
      lastOrgPlan: { filename: 'plan.org' },
    });
    const retried = await app.inject({ method: 'POST', url: '/api/sessions/session-1/restore' });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ state: 'ready', threadId: 'thread-1' });
    expect(attempts).toBe(2);
    await app.close();
  });

  it('restores the original thread after replacement startup fails', async () => {
    const app = fastify();
    const saved: unknown[] = [];
    const runtime = new CodexSessionRuntime(() => ({
      rpc: {
        request: async (method) => {
          if (method === 'thread/resume')
            throw new CodexJsonRpcError(-32600, 'no rollout found for thread id old-thread');
          if (method === 'thread/start') throw new Error('replacement start failed');
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    }));
    registerRestoreSession(app, {
      find: () => ({ ...persistedSession('attentionRequired'), threadId: 'old-thread' }),
      restore: (session) => runtime.restoreWithOutcome(session, 'after'),
      save: (session) => saved.push(session),
    });
    const response = await app.inject({ method: 'POST', url: '/api/sessions/session-1/restore' });
    expect(response.statusCode).toBe(502);
    expect(saved).toMatchObject([
      { state: 'recovering', threadId: 'old-thread' },
      { state: 'attentionRequired', threadId: 'old-thread' },
    ]);
    await app.close();
  });
});

function persistedSession(
  state: 'stopped' | 'released' | 'attentionRequired',
): RelaySessionSnapshot {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    workspacePath: '/workspace',
    profile: 'default',
    threadId: 'thread-1',
    state,
    desiredState: 'stopped',
    activeTurnId: null,
    protocolVersion: null,
    failureCount: 0,
    pendingInteractions: [],
    createdAt: 'before',
    updatedAt: 'before',
  };
}
