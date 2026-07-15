import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { composeRelayApp } from './composition.js';

function fakeAppServer(calls: string[]) {
  return {
    rpc: {
      request: async (method: string) => {
        calls.push(method);
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        return {};
      },
      onNotification: () => () => {},
      onServerRequest: () => () => {},
    },
    close: () => {},
    onExit: () => () => {},
  };
}

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('production composition', () => {
  it('persists a catalog-selected session under the configured data directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-relay-root-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'codex-relay-state-'));
    temporaryPaths.push(root, dataDir);
    await mkdir(join(root, 'workspace'));
    const app = await composeRelayApp({
      root,
      dataDir,
      profiles: {
        list: async () => [{ name: 'default', state: 'ok', status: 'ready' }],
        require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
      },
      installedCodexVersion: 'codex-cli 0.144.3',
    });

    const bootstrap = await app.inject({ method: 'GET', url: '/api/bootstrap' });
    const workspace = bootstrap
      .json()
      .workspaces.find((item: { name: string }) => item.name === 'workspace');
    expect(workspace).toBeDefined();
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workspaceId: workspace!.id, profile: 'default' },
    });
    expect(created.statusCode).toBe(202);
    const restored = await app.inject({ method: 'GET', url: `/api/sessions/${created.json().id}` });
    expect(restored.json()).toMatchObject({
      workspaceId: workspace!.id,
      workspacePath: join(root, 'workspace'),
    });
    await app.close();
  });

  it('restores active persisted threads when the relay restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-relay-root-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'codex-relay-state-'));
    temporaryPaths.push(root, dataDir);
    await mkdir(join(root, 'workspace'));
    const profiles = {
      list: async () => [{ name: 'default', state: 'ok' as const, status: 'ready' }],
      require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' }),
    };
    const firstCalls: string[] = [];
    const first = await composeRelayApp({
      root,
      dataDir,
      profiles,
      installedCodexVersion: 'codex-cli 0.144.3',
      startAppServers: true,
      launchAppServer: () => fakeAppServer(firstCalls),
    });
    const workspace = (await first.inject('/api/bootstrap'))
      .json()
      .workspaces.find((item: { name: string }) => item.name === 'workspace');
    expect(workspace).toBeDefined();
    const created = await first.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workspaceId: workspace!.id, profile: 'default' },
    });
    expect(created.statusCode).toBe(202);
    await first.close();

    const secondCalls: string[] = [];
    const second = await composeRelayApp({
      root,
      dataDir,
      profiles,
      installedCodexVersion: 'codex-cli 0.144.3',
      startAppServers: true,
      launchAppServer: () => fakeAppServer(secondCalls),
    });
    const restored = await second.inject(`/api/sessions/${created.json().id}`);
    expect(restored.json()).toMatchObject({ threadId: 'thread-1', state: 'ready' });
    expect(secondCalls).toEqual(['initialize', 'thread/resume']);
    await second.close();
  });

  it('closes an active Codex child during graceful relay shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-relay-root-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'codex-relay-state-'));
    temporaryPaths.push(root, dataDir);
    await mkdir(join(root, 'workspace'));
    let closed = 0;
    const app = await composeRelayApp({
      root,
      dataDir,
      profiles: {
        list: async () => [{ name: 'default', state: 'ok', status: 'ready' }],
        require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
      },
      installedCodexVersion: 'codex-cli 0.144.3',
      startAppServers: true,
      launchAppServer: () => ({
        rpc: {
          request: async (method: string) =>
            method === 'thread/start' ? { thread: { id: 'thread-1' } } : {},
          onNotification: () => () => {},
          onServerRequest: () => () => {},
        },
        close: () => {
          closed += 1;
        },
        onExit: () => () => {},
      }),
    });
    const workspace = (await app.inject('/api/bootstrap'))
      .json()
      .workspaces.find((item: { name: string }) => item.name === 'workspace');
    await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workspaceId: workspace.id, profile: 'default' },
    });

    await app.close();

    expect(closed).toBe(1);
  });
});
