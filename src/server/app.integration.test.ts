import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';

describe('relay application composition', () => {
  it('uses a fresh Git inspection before pushing', async () => {
    let pushed = false;
    const app = await buildApp({
      health: {
        read: async () => ({
          status: 'ok',
          version: 'test',
          codex: { installedVersion: 'test', protocolVersion: 'test', compatible: true },
        }),
      },
      logger: console,
      sessionRoutes: {
        createId: () => 'unused',
        now: () => '2026-07-14T00:00:00.000Z',
        save: () => undefined,
        find: () => ({ id: 'session-1', workspacePath: '/workspace' }) as never,
        workspaces: {
          resolve: async () => ({ id: 'workspace', name: 'workspace', realPath: '/workspace' }),
        },
        profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
      },
      gitSummary: {
        inspect: async () => ({
          available: true,
          branch: 'main',
          upstream: 'origin/main',
          ahead: 0,
          behind: 0,
          dirty: { staged: 0, unstaged: 0, untracked: 0 },
          commits: [],
          fetchedAt: null,
        }),
        inspectForPush: async () => ({
          available: true,
          branch: 'main',
          upstream: 'origin/main',
          ahead: 1,
          behind: 0,
          dirty: { staged: 0, unstaged: 0, untracked: 0 },
          commits: [],
          fetchedAt: null,
        }),
        push: async () => {
          pushed = true;
        },
        refresh: async () => undefined,
      },
    });

    expect(
      (await app.inject({ method: 'POST', url: '/api/sessions/session-1/git/push' })).statusCode,
    ).toBe(202);
    expect(pushed).toBe(true);
    await app.close();
  });

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
