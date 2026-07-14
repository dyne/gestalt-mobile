import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';

describe('relay application composition', () => {
  it('exposes bootstrap and durable session creation through the application', async () => {
    const sessions: Array<Record<string, unknown>> = [];
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: 'test', protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
      bootstrap: {
        workspaces: {
          list: async () => [{ id: 'workspace-1', name: 'workspace', isGitRepository: false }],
        },
        profiles: { list: async () => [{ name: 'default', state: 'ok', status: 'ready' }] },
        sessions: { list: () => sessions },
        protocolCompatible: true,
      },
      sessionRoutes: {
        createId: () => 'session-1',
        now: () => '2026-07-14T00:00:00.000Z',
        save: (session) => sessions.push(session),
        find: (id) => (sessions.find((session) => session.id === id) as never) ?? null,
        workspaces: {
          resolve: async () => ({
            id: 'workspace-1',
            name: 'workspace',
            realPath: '/relay/workspace',
          }),
        },
        profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
      },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workspaceId: 'workspace-1', profile: 'default' },
    });
    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({ id: 'session-1', state: 'starting' });

    const restored = await app.inject({ method: 'GET', url: '/api/sessions/session-1' });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ id: 'session-1', workspaceId: 'workspace-1' });
    await app.close();
  });
});
