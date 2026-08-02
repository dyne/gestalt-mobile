/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { once } from 'node:events';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { composeRelayApp } from './composition.js';
import { workspaceId } from './platform/catalog/workspace-id.js';
import {
  planStatusDirectoryPath,
  planStatusFilePath,
} from './platform/plans/filesystem-plan-status-source.js';

function fakeAppServer(calls: string[]) {
  return {
    rpc: {
      request: async (method: string, params: unknown) => {
        calls.push(method);
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'model/list') return { data: [{ id: 'gpt-5.6-terra' }] };
        if (method === 'skills/list')
          return { data: [{ cwd: (params as { cwds: string[] }).cwds[0], skills: [], errors: [] }] };
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
  it('does not resolve a Git operation target outside the configured root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'gestalt-mobile-outside-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
    temporaryPaths.push(root, outside, dataDir);
    await mkdir(join(outside, '.git'));
    await symlink(outside, join(root, 'escape'));
    const app = await composeRelayApp({
      root,
      dataDir,
      profiles: {
        list: async () => [{ name: 'default', state: 'ok', status: 'ready' }],
        require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
      },
      installedCodexVersion: 'codex-cli 0.144.3',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/git/repositories/${workspaceId(outside)}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'WORKSPACE_NOT_FOUND' });
    await app.close();
  });

  it('persists a catalog-selected session under the configured data directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
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
      launchAppServer: () => fakeAppServer([]),
    });

    const bootstrap = await app.inject({ method: 'GET', url: '/api/bootstrap' });
    const workspace = bootstrap
      .json()
      .workspaces[0]?.children.find((item: { name: string }) => item.name === 'workspace');
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

  it('journals and replays a session-owned plan replacement before streaming its close event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
    temporaryPaths.push(root, dataDir);
    const workspacePath = join(root, 'workspace');
    await mkdir(workspacePath);
    const planPath = join(workspacePath, 'plan.org');
    await writeFile(
      planPath,
      `#+TITLE: Completed plan
* DONE [#A] Closeable work
:PROPERTIES:
:ID: closeable-work
:SKILLS: $gestalt:org-plan
:REVIEW_STATUS: UNREVIEWED
:END:
- Effort :: Small
- Goal :: Exercise session event composition.
- Notes :: Complete.
`,
    );
    const profiles = {
      list: async () => [{ name: 'default', state: 'ok' as const, status: 'ready' as const }],
      require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' as const }),
    };
    const app = await composeRelayApp({
      root,
      dataDir,
      profiles,
      installedCodexVersion: 'codex-cli 0.144.3',
      startAppServers: true,
      launchAppServer: () => fakeAppServer([]),
    });
    const workspace = (await app.inject('/api/bootstrap'))
      .json()
      .workspaces[0]?.children.find((item: { name: string }) => item.name === 'workspace');
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workspaceId: workspace.id, profile: 'default' },
    });
    const sessionId = created.json().id as string;
    await writeFile(
      planStatusFilePath(planStatusDirectoryPath(workspacePath, sessionId), planPath),
      JSON.stringify({
        schemaVersion: 1,
        planPath,
        reason: 'supervision-start',
        updatedAt: '2026-08-01T00:00:00.000Z',
      }),
    );
    await expect.poll(async () => (await app.inject(`/api/sessions/${sessionId}/plan`)).statusCode).toBe(
      200,
    );
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/sessions/${sessionId}/events?after=0`,
    );
    const messages: Array<{ type: string; event: { type: string; sequence: number; payload: unknown } }> = [];
    socket.on('message', (data) => messages.push(JSON.parse(String(data))));
    await once(socket, 'open');
    await vi.waitFor(() => expect(messages.some((message) => message.event.type === 'plan.updated')).toBe(true));
    const updatedIndex = messages.findIndex((message) => message.event.type === 'plan.updated');
    expect(messages[updatedIndex]).toMatchObject({
      type: 'relay.event',
      event: {
        type: 'plan.updated',
        payload: { plan: { title: 'Completed plan', allDone: true }, reason: 'supervision-start' },
      },
    });
    expect((await app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/plan` })).statusCode).toBe(
      204,
    );
    await vi.waitFor(() => expect(messages.some((message) => message.event.type === 'plan.closed')).toBe(true));
    const closedIndex = messages.findIndex((message) => message.event.type === 'plan.closed');
    expect(messages[closedIndex]).toMatchObject({
      type: 'relay.event',
      event: { type: 'plan.closed', payload: {} },
    });
    expect(closedIndex).toBeGreaterThan(updatedIndex);
    const updatesBeforeResync = messages.filter((message) => message.event.type === 'plan.updated').length;
    await writeFile(
      planStatusFilePath(planStatusDirectoryPath(workspacePath, sessionId), planPath),
      JSON.stringify({
        schemaVersion: 1,
        planPath,
        reason: 'same-plan-resync',
        updatedAt: '2026-08-01T00:00:01.000Z',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(messages.filter((message) => message.event.type === 'plan.updated')).toHaveLength(
      updatesBeforeResync,
    );
    socket.close();
    await app.close();
    const restarted = await composeRelayApp({
      root,
      dataDir,
      profiles,
      installedCodexVersion: 'codex-cli 0.144.3',
      startAppServers: true,
      launchAppServer: () => fakeAppServer([]),
    });
    await restarted.listen({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await restarted.inject(`/api/sessions/${sessionId}/plan`)).statusCode).toBe(204);
    const nextPlanPath = join(workspacePath, 'next-plan.org');
    await writeFile(
      nextPlanPath,
      `#+TITLE: Different plan
* DONE [#A] Different work
:PROPERTIES:
:ID: different-work
:SKILLS: $gestalt:org-plan
:REVIEW_STATUS: UNREVIEWED
:END:
- Effort :: Small
- Goal :: Prove a different plan can replace a dismissed one.
- Notes :: Complete.
`,
    );
    await writeFile(
      planStatusFilePath(planStatusDirectoryPath(workspacePath, sessionId), nextPlanPath),
      JSON.stringify({
        schemaVersion: 1,
        planPath: nextPlanPath,
        reason: 'different-plan',
        updatedAt: '2026-08-01T00:00:02.000Z',
      }),
    );
    await expect.poll(async () => (await restarted.inject(`/api/sessions/${sessionId}/plan`)).json().title).toBe(
      'Different plan',
    );
    await restarted.close();
  });

  it('restores active persisted threads when the relay restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
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
      .workspaces[0]?.children.find((item: { name: string }) => item.name === 'workspace');
    expect(workspace).toBeDefined();
    const created = await first.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workspaceId: workspace!.id, profile: 'default' },
    });
    expect(created.statusCode).toBe(202);
    expect(firstCalls).toEqual([
      'initialize', 'model/list', 'initialize', 'model/list', 'initialize', 'skills/list',
      'initialize', 'skills/list', 'initialize', 'thread/start',
    ]);
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
    expect(secondCalls).toEqual([]);
    await second.listen({ host: '127.0.0.1', port: 0 });
    await expect.poll(() => secondCalls, { timeout: 1_000 }).toEqual([
      'initialize', 'skills/list', 'initialize', 'skills/list', 'initialize', 'thread/resume',
    ]);
    const restored = await second.inject(`/api/sessions/${created.json().id}`);
    expect(restored.json()).toMatchObject({ threadId: 'thread-1', state: 'ready' });
    await second.close();
  });

  it('closes an active Codex child during graceful relay shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
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
          request: async (method: string, params: unknown) => {
            if (method === 'model/list') return { data: [{ id: 'gpt-5.6-terra' }] };
            if (method === 'skills/list')
              return { data: [{ cwd: (params as { cwds: string[] }).cwds[0], skills: [], errors: [] }] };
            return method === 'thread/start' ? { thread: { id: 'thread-1' } } : {};
          },
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
      .workspaces[0]?.children.find((item: { name: string }) => item.name === 'workspace');
    await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workspaceId: workspace.id, profile: 'default' },
    });

    await app.close();

    // Model and skill catalogs run for bootstrap and session start; the active child closes with the relay.
    expect(closed).toBe(5);
  });
});
