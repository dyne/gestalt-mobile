/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerStartSession } from './endpoint.js';

const skills = {
  skillProfiles: {
    readGlobalProfile: async () => undefined,
    readWorkspaceDefault: async () => undefined,
  },
  skillCatalog: () => ({
    list: async () => ({
      skills: [{ name: 'Native', path: '/skills/native/SKILL.md', enabled: true }],
      errors: [],
    }),
  }),
};

describe('POST /api/sessions', () => {
  it('reports an unavailable executor model as a recoverable settings problem before persistence', async () => {
    const app = fastify();
    const save = vi.fn();
    const activate = vi.fn();
    registerStartSession(app, {
      createId: () => 's',
      now: () => 't',
      save,
      activate,
      workspaces: { resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/w' }) },
      profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
      models: { list: async () => ['available'] },
      ...skills,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          workspaceId: 'w',
          profile: 'default',
          provider: 'codex',
          model: 'available',
          executorModel: 'removed',
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'CODEX_EXECUTOR_MODEL_UNAVAILABLE',
        retryable: true,
      });
      expect(save).not.toHaveBeenCalled();
      expect(activate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it.each(['SESSION_SCRATCH_CONTAINMENT_BUSY', 'SESSION_SCRATCH_CONTAINMENT_INVALID'])(
    'reports %s as bounded retryable workspace failure before saving or activating',
    async (code) => {
      const app = fastify();
      const save = vi.fn();
      const activate = vi.fn(async () => {
        throw new Error('Unexpected activation');
      });
      registerStartSession(app, {
        createId: () => 's',
        now: () => 't',
        save,
        activate,
        publish: async () => {
          throw new Error(`${code} /private/source`);
        },
        workspaces: { resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/w' }) },
        profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
        ...skills,
      });
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { workspaceId: 'w', profile: 'default', provider: 'codex' },
        });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({
          code: 'SESSION_WORKSPACE_UNAVAILABLE',
          retryable: true,
        });
        expect(response.body).not.toContain('/private/source');
        expect(save).not.toHaveBeenCalled();
        expect(activate).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it('accepts a new session', async () => {
    const app = fastify();
    registerStartSession(app, {
      createId: () => 's',
      now: () => 't',
      save: () => {},
      workspaces: { resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/w' }) },
      profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
      ...skills,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workspaceId: 'w', profile: 'default', provider: 'codex' },
    });
    expect(response.statusCode).toBe(202);
    await app.close();
  });

  it('rejects settings outside the generated Codex schema values', async () => {
    const app = fastify();
    registerStartSession(app, {
      createId: () => 's',
      now: () => 't',
      save: () => {},
      workspaces: { resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/w' }) },
      profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
      ...skills,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        workspaceId: 'w',
        profile: 'default',
        provider: 'codex',
        sandbox: 'workspaceWrite',
        approvalPolicy: 'never',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_START_SESSION_REQUEST' });
    await app.close();
  });

  it('accepts the managed workspace-git permission profile', async () => {
    const app = fastify();
    let receivedSandbox: string | undefined;
    registerStartSession(app, {
      createId: () => 's',
      now: () => 't',
      save: () => {},
      workspaces: { resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/w' }) },
      profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
      ...skills,
      activate: async (session) => {
        receivedSandbox = session.executionPolicy?.sandbox;
        return session;
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        workspaceId: 'w',
        profile: 'default',
        provider: 'codex',
        sandbox: 'workspace-git',
        approvalPolicy: 'on-request',
      },
    });

    expect(response.statusCode).toBe(202);
    expect(receivedSandbox).toBe('workspace-git');
    await app.close();
  });

  it('replays a successful start for the same idempotency key', async () => {
    const app = fastify();
    const results = new Map<string, string>();
    let created = 0;
    registerStartSession(app, {
      createId: () => `s-${++created}`,
      now: () => 't',
      save: () => {},
      workspaces: { resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/w' }) },
      profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
      ...skills,
      idempotency: {
        get: (_scope, key) =>
          results.has(key) ? { statusCode: 202, body: results.get(key)! } : null,
        put: (_scope, key, _statusCode, body) => results.set(key, body),
      },
    });
    const options = {
      method: 'POST' as const,
      url: '/api/sessions',
      headers: { 'idempotency-key': 'retry-1' },
      payload: { workspaceId: 'w', profile: 'default', provider: 'codex' },
    };
    const first = await app.inject(options);
    const second = await app.inject(options);
    expect([first.json().id, second.json().id]).toEqual(['s-1', 's-1']);
    expect(created).toBe(1);
    await app.close();
  });

  it('reports an activation failure before returning the problem response', async () => {
    const app = fastify();
    const failures: string[] = [];
    registerStartSession(app, {
      createId: () => 's',
      now: () => 't',
      save: () => {},
      workspaces: { resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/w' }) },
      profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
      ...skills,
      activate: async () => {
        throw new Error('CODEX_START_FAILED');
      },
      reportFailure: (_operation, error) =>
        failures.push(error instanceof Error ? error.message : 'unknown'),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workspaceId: 'w', profile: 'default', provider: 'codex' },
    });
    expect(response.statusCode).toBe(500);
    expect(failures).toEqual(['CODEX_START_FAILED']);
    await app.close();
  });

  it('rejects an unknown named skill profile', async () => {
    const app = fastify();
    registerStartSession(app, {
      createId: () => 's',
      now: () => 't',
      save: () => {},
      workspaces: { resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/w' }) },
      profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
      ...skills,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workspaceId: 'w', profile: 'default', provider: 'codex', skillProfile: 'missing' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'UNKNOWN_SKILL_PROFILE' });
    await app.close();
  });
});
