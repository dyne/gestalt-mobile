/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerForgetSession } from './endpoint.js';
import { registerSessionRoutes } from '../register-routes.js';
import { RelaySession } from '../model/relay-session.js';
import type { SessionForgetOperation } from '../../../../shared/contracts/session-forget.js';

describe('DELETE /api/sessions/:id', () => {
  const operation: SessionForgetOperation = {
    sessionId: 'session-1',
    operationId: 'forget-1',
    phase: 'failed',
    updatedAt: '2026-01-01T00:00:00.000Z',
    failureCode: 'SESSION_CLEANUP_FAILED',
  };

  it('reports retryable cleanup failure instead of a false successful deletion', async () => {
    const app = fastify();
    const remove = vi.fn();
    registerForgetSession(app, {
      find: () => ({ id: 'session-1' }) as never,
      forget: async () => operation,
      remove,
    });
    try {
      const reply = await app.inject({ method: 'DELETE', url: '/api/sessions/session-1' });
      expect(reply.statusCode).toBe(503);
      expect(reply.json()).toEqual({ code: 'SESSION_FORGET_FAILED', operation });
      expect(remove).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns idempotent success for an already completed operation after roster removal', async () => {
    const app = fastify();
    registerForgetSession(app, {
      find: () => null,
      forget: async () => ({ ...operation, phase: 'completed' }),
    });
    try {
      expect(
        (await app.inject({ method: 'DELETE', url: '/api/sessions/session-1' })).statusCode,
      ).toBe(204);
    } finally {
      await app.close();
    }
  });

  it('returns not found when neither session nor durable operation exists', async () => {
    const app = fastify();
    registerForgetSession(app, { find: () => null, forget: async () => null });
    try {
      expect(
        (await app.inject({ method: 'DELETE', url: '/api/sessions/missing' })).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });

  const session = () => ({
    ...RelaySession.create({
      id: 'session-1',
      workspaceId: 'w',
      workspacePath: '/w',
      provider: 'codex',
      profile: 'default',
      effectiveSkillSelection: { skills: [] },
      now: '2026-01-01T00:00:00.000Z',
    }).snapshot,
    state: 'released' as const,
    desiredState: 'stopped' as const,
    threadId: 'provider-thread',
  });

  it('recovers durable frame metadata through list/get and fences a later restore', async () => {
    const app = fastify();
    const restore = vi.fn(async () => session());
    registerSessionRoutes(app, {
      sessionRoutes: {
        find: () => session(),
        list: () => [session()],
        forgetOperation: () => operation,
        restore,
        save: vi.fn(),
        now: () => operation.updatedAt,
      } as never,
      logger: console,
    });
    try {
      expect((await app.inject('/api/sessions')).json()[0].forgetOperation).toEqual(operation);
      expect((await app.inject('/api/sessions/session-1')).json().forgetOperation).toEqual(
        operation,
      );
      expect(
        (await app.inject({ method: 'POST', url: '/api/sessions/session-1/restore' })).statusCode,
      ).toBe(409);
      expect(restore).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not report a late restore as successful after Forget acquired its durable fence', async () => {
    const app = fastify();
    let current: SessionForgetOperation | null = null;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerSessionRoutes(app, {
      sessionRoutes: {
        find: () => session(),
        forgetOperation: () => current,
        restore: async () => {
          enter();
          await gate;
          return { ...session(), state: 'ready' };
        },
        save: vi.fn(),
        now: () => operation.updatedAt,
      } as never,
      logger: console,
    });
    const response = app.inject({ method: 'POST', url: '/api/sessions/session-1/restore' });
    try {
      let reached = false;
      void entered.then(() => {
        reached = true;
      });
      await vi.waitFor(() => expect(reached).toBe(true), { timeout: 2000 });
      current = { ...operation, phase: 'stopping' };
      release();
      expect((await response).statusCode).toBe(409);
    } finally {
      release();
      await response;
      await app.close();
    }
  });

  it('closes the relay runtime and removes only the managed session record', async () => {
    const app = fastify();
    const calls: string[] = [];
    registerForgetSession(app, {
      find: () => ({ id: 'session-1' }) as never,
      close: () => {
        calls.push('close');
      },
      remove: () => calls.push('remove'),
    });

    expect(
      (await app.inject({ method: 'DELETE', url: '/api/sessions/session-1' })).statusCode,
    ).toBe(204);
    expect(calls).toEqual(['close', 'remove']);
    await app.close();
  });
});
