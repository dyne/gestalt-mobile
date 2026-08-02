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

import { composeRelayApp, type ComposeRelayAppOptions } from './composition.js';
import { SqliteAuthorizationStore } from './platform/auth/sqlite-authorization-store.js';
import {
  authorizationSessionId,
  authorizedDeviceId,
  localOwnerId,
  webAuthnCredentialId,
} from './features/auth/domain/identifiers.js';
import { deviceNickname } from './features/auth/domain/device-nickname.js';
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
          return {
            data: [{ cwd: (params as { cwds: string[] }).cwds[0], skills: [], errors: [] }],
          };
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
const relyingParty = {
  publicOrigin: 'http://localhost:3000',
  rpId: 'localhost',
  rpName: 'Gestalt Mobile' as const,
};

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function composeAuthorizedApp(options: ComposeRelayAppOptions) {
  const homeDirectory =
    options.homeDirectory ?? (await mkdtemp(join(tmpdir(), 'gestalt-mobile-home-')));
  if (!options.homeDirectory) temporaryPaths.push(homeDirectory);
  const store = new SqliteAuthorizationStore(homeDirectory, options.relyingParty);
  const owner = { id: localOwnerId('local-owner'), userHandle: new Uint8Array(32).fill(1) };
  store.initializeOwner(owner.userHandle);
  const device = {
    id: authorizedDeviceId('test-device'),
    credentialId: webAuthnCredentialId('test-credential'),
    publicKey: new Uint8Array([1]),
    counter: 0,
    transports: ['internal'] as const,
    deviceType: 'singleDevice' as const,
    backedUp: false,
    nickname: deviceNickname('Test device'),
    createdAt: '2026-08-02T00:00:00.000Z',
  };
  store.claimFirstDevice(owner, device);
  if (!store.sessionDevice(authorizationSessionId('test-session'), '2026-08-02T00:00:00.000Z'))
    store.saveSession(authorizationSessionId('test-session'), {
      deviceId: device.id,
      expiresAt: '2026-09-01T00:00:00.000Z',
    });
  store.close();
  const app = await composeRelayApp({ ...options, homeDirectory });
  const inject = app.inject.bind(app) as (options: unknown) => Promise<unknown>;
  app.inject = ((
    request: string | { headers?: Record<string, string>; [key: string]: unknown },
  ) => {
    if (typeof request === 'string')
      return inject({ url: request, headers: { cookie: 'gestalt_mobile_session=test-session' } });
    return inject({
      ...request,
      headers: {
        cookie: 'gestalt_mobile_session=test-session',
        ...(request.method && request.method !== 'GET'
          ? { origin: options.relyingParty.publicOrigin }
          : {}),
        ...request.headers,
      },
    });
  }) as never;
  return app;
}

async function createUnauthorizedProductionApp(root: string, dataDir: string) {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-home-'));
  temporaryPaths.push(homeDirectory);
  return composeRelayApp({
    root,
    dataDir,
    homeDirectory,
    relyingParty,
    profiles: {
      list: async () => [],
      require: async () => ({
        name: 'default' as const,
        state: 'ok' as const,
        status: 'ready' as const,
      }),
    },
    installedCodexVersion: null,
  });
}

describe('production composition', () => {
  it('inventory-classifies every production API route and reserves exactly five public entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
    temporaryPaths.push(root, dataDir);
    const app = await composeAuthorizedApp({
      root,
      dataDir,
      relyingParty,
      profiles: {
        list: async () => [],
        require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' as const }),
      },
      installedCodexVersion: null,
    });
    const routes = [
      ['GET', '/api/auth/status', '/api/auth/status', 'public'],
      ['POST', '/api/auth/login/options', '/api/auth/login/options', 'public'],
      ['POST', '/api/auth/login/verify', '/api/auth/login/verify', 'public'],
      ['POST', '/api/auth/register/options', '/api/auth/register/options', 'public'],
      ['POST', '/api/auth/register/verify', '/api/auth/register/verify', 'public'],
      ['HEAD', '/api/auth/status', '/api/auth/status', 'protected'],
      ['POST', '/api/auth/logout', '/api/auth/logout', 'protected'],
      ['POST', '/api/auth/enrollment-tickets', '/api/auth/enrollment-tickets', 'protected'],
      ['GET', '/api/auth/enrollment-tickets/current', '/api/auth/enrollment-tickets/current', 'protected'],
      ['HEAD', '/api/auth/enrollment-tickets/current', '/api/auth/enrollment-tickets/current', 'protected'],
      ['DELETE', '/api/auth/enrollment-tickets/current', '/api/auth/enrollment-tickets/current', 'protected'],
      ['GET', '/api/auth/devices', '/api/auth/devices', 'protected'],
      ['HEAD', '/api/auth/devices', '/api/auth/devices', 'protected'],
      ['PATCH', '/api/auth/devices/:deviceId', '/api/auth/devices/device-1', 'protected'],
      ['DELETE', '/api/auth/devices/:deviceId', '/api/auth/devices/device-1', 'protected'],
      ['GET', '/api/bootstrap', '/api/bootstrap', 'protected'],
      ['HEAD', '/api/bootstrap', '/api/bootstrap', 'protected'],
      ['POST', '/api/sessions', '/api/sessions', 'protected'],
      ['GET', '/api/sessions', '/api/sessions', 'protected'],
      ['HEAD', '/api/sessions', '/api/sessions', 'protected'],
      ['GET', '/api/sessions/recent-threads', '/api/sessions/recent-threads', 'protected'],
      ['HEAD', '/api/sessions/recent-threads', '/api/sessions/recent-threads', 'protected'],
      ['GET', '/api/sessions/:id', '/api/sessions/session-1', 'protected'],
      ['HEAD', '/api/sessions/:id', '/api/sessions/session-1', 'protected'],
      ['POST', '/api/sessions/:id/model', '/api/sessions/session-1/model', 'protected'],
      ['GET', '/api/sessions/:id/plan', '/api/sessions/session-1/plan', 'protected'],
      ['HEAD', '/api/sessions/:id/plan', '/api/sessions/session-1/plan', 'protected'],
      ['DELETE', '/api/sessions/:id/plan', '/api/sessions/session-1/plan', 'protected'],
      ['GET', '/api/git/repositories/:workspaceId', '/api/git/repositories/workspace-1', 'protected'],
      ['HEAD', '/api/git/repositories/:workspaceId', '/api/git/repositories/workspace-1', 'protected'],
      ['POST', '/api/git/repositories/:workspaceId/push', '/api/git/repositories/workspace-1/push', 'protected'],
      ['POST', '/api/git/repositories/:workspaceId/refresh', '/api/git/repositories/workspace-1/refresh', 'protected'],
      ['POST', '/api/git/repositories/:workspaceId/pull', '/api/git/repositories/workspace-1/pull', 'protected'],
      ['POST', '/api/git/repositories/:workspaceId/checkout', '/api/git/repositories/workspace-1/checkout', 'protected'],
      ['POST', '/api/git/clone', '/api/git/clone', 'protected'],
      ['GET', '/api/skills', '/api/skills', 'protected'],
      ['HEAD', '/api/skills', '/api/skills', 'protected'],
      ['GET', '/api/skill-profiles', '/api/skill-profiles', 'protected'],
      ['HEAD', '/api/skill-profiles', '/api/skill-profiles', 'protected'],
      ['PUT', '/api/skill-profiles/:name', '/api/skill-profiles/default', 'protected'],
      ['DELETE', '/api/skill-profiles/:name', '/api/skill-profiles/default', 'protected'],
    ] as const;
    const routePaths: string[] = [];
    const inventory = app
      .printRoutes({ commonPrefix: false })
      .split('\n')
      .flatMap((line) => {
        const match = line.match(/^(.*)[├└]── (\/\S+) \(([^)]+)\)$/);
        if (!match) return [];
        const depth = match[1].length / 4;
        routePaths.splice(depth);
        routePaths[depth] = depth === 0 ? match[2] : `${routePaths[depth - 1]}${match[2]}`;
        if (!routePaths[depth].startsWith('/api/')) return [];
        return match[3].split(', ').map((method) => `${method} ${routePaths[depth]}`);
      })
      .sort();
    const expectedInventory = routes.map(([method, pattern]) => `${method} ${pattern}`).sort();
    expect(inventory).toEqual(expectedInventory);
    expect(routes.filter(([, , , access]) => access === 'public')).toEqual([
      ['GET', '/api/auth/status', '/api/auth/status', 'public'],
      ['POST', '/api/auth/login/options', '/api/auth/login/options', 'public'],
      ['POST', '/api/auth/login/verify', '/api/auth/login/verify', 'public'],
      ['POST', '/api/auth/register/options', '/api/auth/register/options', 'public'],
      ['POST', '/api/auth/register/verify', '/api/auth/register/verify', 'public'],
    ]);
    const unauthorized = await createUnauthorizedProductionApp(root, dataDir);
    for (const [method, pattern, url, access] of routes) {
      const response = await unauthorized.inject({
        method,
        url,
        headers: method === 'GET' || method === 'HEAD' ? {} : { origin: relyingParty.publicOrigin },
      });
      if (access === 'public') {
        expect(response.statusCode, `${method} ${pattern}`).not.toBe(401);
        expect(response.body, `${method} ${pattern}`).not.toContain('AUTH_REQUIRED');
      } else {
        expect(response.statusCode, `${method} ${pattern}`).toBe(401);
        if (method !== 'HEAD')
          expect(response.json(), `${method} ${pattern}`).toMatchObject({ code: 'AUTH_REQUIRED' });
      }
    }
    await unauthorized.close();
    await app.close();
  });
  it('shares one authorization owner across independently composed relay databases and closes handles independently', async () => {
    const rootOne = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
    const rootTwo = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
    const dataOne = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
    const dataTwo = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
    const sharedHome = await mkdtemp(join(tmpdir(), 'gestalt-mobile-home-'));
    temporaryPaths.push(rootOne, rootTwo, dataOne, dataTwo, sharedHome);
    const profiles = {
      list: async () => [],
      require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' as const }),
    };
    const firstHandle = new Uint8Array(32).fill(1);
    const secondHandle = new Uint8Array(32).fill(9);
    const first = await composeRelayApp({
      root: rootOne,
      dataDir: dataOne,
      homeDirectory: sharedHome,
      relyingParty,
      profiles,
      installedCodexVersion: null,
      authorizationRandomBytes: () => firstHandle,
    });
    const second = await composeRelayApp({
      root: rootTwo,
      dataDir: dataTwo,
      homeDirectory: sharedHome,
      relyingParty,
      profiles,
      installedCodexVersion: null,
      authorizationRandomBytes: () => secondHandle,
    });
    await first.close();
    expect((await second.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const store = new SqliteAuthorizationStore(sharedHome, relyingParty);
    expect(store.readOwner()?.userHandle).toEqual(firstHandle);
    store.close();
    await second.close();
  });

  it('rejects malformed authorization randomness before opening a durable auth handle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
    const home = await mkdtemp(join(tmpdir(), 'gestalt-mobile-home-'));
    temporaryPaths.push(root, dataDir, home);
    await expect(
      composeRelayApp({
        root,
        dataDir,
        homeDirectory: home,
        relyingParty,
        profiles: {
          list: async () => [],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
        installedCodexVersion: null,
        authorizationRandomBytes: () => new Uint8Array(31),
      }),
    ).rejects.toThrow('exactly 32');
    const store = new SqliteAuthorizationStore(home, relyingParty);
    expect(store.readOwner()).toBeNull();
    store.close();
  });

  it('closes authorization and relay handles when app construction fails after owner initialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
    const home = await mkdtemp(join(tmpdir(), 'gestalt-mobile-home-'));
    const notDirectory = join(root, 'not-a-directory');
    temporaryPaths.push(root, dataDir, home);
    await writeFile(notDirectory, 'x');
    await expect(
      composeRelayApp({
        root,
        dataDir,
        homeDirectory: home,
        staticDir: notDirectory,
        relyingParty,
        profiles: {
          list: async () => [],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
        installedCodexVersion: null,
        authorizationRandomBytes: () => new Uint8Array(32).fill(7),
      }),
    ).rejects.toThrow();
    const store = new SqliteAuthorizationStore(home, relyingParty);
    expect(store.readOwner()?.userHandle).toEqual(new Uint8Array(32).fill(7));
    store.close();
  });

  it('closes the relay handle when authorization initialization rejects an RP migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
    const home = await mkdtemp(join(tmpdir(), 'gestalt-mobile-home-'));
    temporaryPaths.push(root, dataDir, home);
    const seeded = new SqliteAuthorizationStore(home, relyingParty);
    const owner = { id: localOwnerId('local-owner'), userHandle: new Uint8Array(32).fill(1) };
    seeded.initializeOwner(owner.userHandle);
    seeded.claimFirstDevice(owner, {
      id: authorizedDeviceId('device'),
      credentialId: webAuthnCredentialId('credential'),
      publicKey: new Uint8Array([1]),
      counter: 0,
      transports: ['internal'],
      deviceType: 'singleDevice',
      backedUp: false,
      nickname: deviceNickname('Device'),
      createdAt: '2026-08-02T00:00:00.000Z',
    });
    seeded.close();
    const migrated = {
      publicOrigin: 'https://other.example',
      rpId: 'other.example',
      rpName: 'Gestalt Mobile' as const,
    };
    await expect(
      composeRelayApp({
        root,
        dataDir,
        homeDirectory: home,
        relyingParty: migrated,
        profiles: {
          list: async () => [],
          require: async () => ({
            name: 'default',
            state: 'ok' as const,
            status: 'ready' as const,
          }),
        },
        installedCodexVersion: null,
        authorizationRandomBytes: () => new Uint8Array(32).fill(2),
      }),
    ).rejects.toThrow('hostname changed');
    const reopened = new SqliteAuthorizationStore(home, relyingParty);
    expect(reopened.listAuthorizedDevices()).toHaveLength(1);
    reopened.close();
  });

  it('rejects a relying-party identity that does not match its canonical origin', async () => {
    await expect(
      composeRelayApp({
        root: '/unused',
        relyingParty: { ...relyingParty, rpId: 'other.example' },
        profiles: {
          list: async () => [],
          require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
        },
        installedCodexVersion: null,
      }),
    ).rejects.toThrow('Invalid WebAuthn relying-party configuration');
  });

  it('does not resolve a Git operation target outside the configured root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'gestalt-mobile-outside-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
    temporaryPaths.push(root, outside, dataDir);
    await mkdir(join(outside, '.git'));
    await symlink(outside, join(root, 'escape'));
    const app = await composeAuthorizedApp({
      root,
      dataDir,
      relyingParty,
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
    const app = await composeAuthorizedApp({
      root,
      dataDir,
      relyingParty,
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
    const app = await composeAuthorizedApp({
      root,
      dataDir,
      relyingParty,
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
    await expect
      .poll(async () => (await app.inject(`/api/sessions/${sessionId}/plan`)).statusCode)
      .toBe(200);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/sessions/${sessionId}/events?after=0`,
      {
        headers: {
          origin: relyingParty.publicOrigin,
          cookie: 'gestalt_mobile_session=test-session',
        },
      },
    );
    const messages: Array<{
      type: string;
      event: { type: string; sequence: number; payload: unknown };
    }> = [];
    socket.on('message', (data) => messages.push(JSON.parse(String(data))));
    await once(socket, 'open');
    await vi.waitFor(() =>
      expect(messages.some((message) => message.event.type === 'plan.updated')).toBe(true),
    );
    const updatedIndex = messages.findIndex((message) => message.event.type === 'plan.updated');
    expect(messages[updatedIndex]).toMatchObject({
      type: 'relay.event',
      event: {
        type: 'plan.updated',
        payload: { plan: { title: 'Completed plan', allDone: true }, reason: 'supervision-start' },
      },
    });
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}/plan` })).statusCode,
    ).toBe(204);
    await vi.waitFor(() =>
      expect(messages.some((message) => message.event.type === 'plan.closed')).toBe(true),
    );
    const closedIndex = messages.findIndex((message) => message.event.type === 'plan.closed');
    expect(messages[closedIndex]).toMatchObject({
      type: 'relay.event',
      event: { type: 'plan.closed', payload: {} },
    });
    expect(closedIndex).toBeGreaterThan(updatedIndex);
    const updatesBeforeResync = messages.filter(
      (message) => message.event.type === 'plan.updated',
    ).length;
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
    const restarted = await composeAuthorizedApp({
      root,
      dataDir,
      relyingParty,
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
    await expect
      .poll(async () => (await restarted.inject(`/api/sessions/${sessionId}/plan`)).json().title)
      .toBe('Different plan');
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
    const first = await composeAuthorizedApp({
      root,
      dataDir,
      relyingParty,
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
      'initialize',
      'model/list',
      'initialize',
      'model/list',
      'initialize',
      'skills/list',
      'initialize',
      'skills/list',
      'initialize',
      'thread/start',
    ]);
    await first.close();

    const secondCalls: string[] = [];
    const second = await composeAuthorizedApp({
      root,
      dataDir,
      relyingParty,
      profiles,
      installedCodexVersion: 'codex-cli 0.144.3',
      startAppServers: true,
      launchAppServer: () => fakeAppServer(secondCalls),
    });
    expect(secondCalls).toEqual([]);
    await second.listen({ host: '127.0.0.1', port: 0 });
    await expect
      .poll(() => secondCalls, { timeout: 1_000 })
      .toEqual([
        'initialize',
        'skills/list',
        'initialize',
        'skills/list',
        'initialize',
        'thread/resume',
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
    const app = await composeAuthorizedApp({
      root,
      dataDir,
      relyingParty,
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
              return {
                data: [{ cwd: (params as { cwds: string[] }).cwds[0], skills: [], errors: [] }],
              };
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
