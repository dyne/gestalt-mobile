/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  composeRelayApp as createRelayApp,
  type ComposeRelayAppOptions,
} from '../../src/server/composition.js';
import { SqliteAuthorizationStore } from '../../src/server/platform/auth/sqlite-authorization-store.js';
import {
  authorizationSessionId,
  authorizedDeviceId,
  localOwnerId,
  webAuthnCredentialId,
} from '../../src/server/features/auth/domain/identifiers.js';
import { deviceNickname } from '../../src/server/features/auth/domain/device-nickname.js';

const relyingParty = {
  publicOrigin: 'http://localhost:3000',
  rpId: 'localhost',
  rpName: 'Gestalt Mobile' as const,
};
import type { WorkspaceOption } from '../../src/server/features/catalog/application/ports.js';
import {
  createSkillProfile,
  serializeSkillProfileYaml,
} from '../../src/server/features/skills/model/skill-profile.js';
import { FilesystemSkillProfileStore } from '../../src/server/platform/skills/filesystem-skill-profile-store.js';
const paths: string[] = [];
afterEach(async () =>
  Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);
async function composeRelayApp(options: ComposeRelayAppOptions) {
  const homeDirectory =
    options.homeDirectory ?? (await mkdtemp(join(tmpdir(), 'gestalt-mobile-home-')));
  if (!options.homeDirectory) paths.push(homeDirectory);
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
  const app = await createRelayApp({ ...options, homeDirectory });
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
function fakeAppServer(calls: string[]) {
  return {
    rpc: {
      request: async (method: string, params: unknown) => {
        calls.push(method);
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
    close: () => {},
    onExit: () => () => {},
  };
}
test('keeps a persisted thread detached after an HTTP relay restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
  paths.push(root, dataDir);
  await mkdir(join(root, 'workspace'));
  const profiles = {
    list: async () => [{ name: 'default', state: 'ok' as const, status: 'ready' }],
    require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' }),
  };
  const first = await composeRelayApp({
    root,
    dataDir,
    relyingParty,
    profiles,
    installedCodexVersion: 'codex-cli 0.144.3',
    startAppServers: true,
    launchAppServer: () => fakeAppServer([]),
  });
  await first.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(first.server.address() as { port: number }).port}`;
  const bootstrap = await fetch(`${base}/api/bootstrap`, {
    headers: { cookie: 'gestalt_mobile_session=test-session' },
  }).then((response) => response.json() as Promise<{ workspaces: WorkspaceOption[] }>);
  const workspace = bootstrap.workspaces[0]?.children[0];
  expect(bootstrap.workspaces).toMatchObject([
    {
      relativePath: '.',
      children: [{ id: workspace?.id, name: 'workspace', relativePath: 'workspace' }],
    },
  ]);
  const created = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: 'gestalt_mobile_session=test-session',
      origin: relyingParty.publicOrigin,
    },
    body: JSON.stringify({ workspaceId: workspace?.id, profile: 'default' }),
  }).then((response) => response.json() as Promise<{ id: string }>);
  await first.close();
  const restoredCalls: string[] = [];
  const second = await composeRelayApp({
    root,
    dataDir,
    relyingParty,
    profiles,
    installedCodexVersion: 'codex-cli 0.144.3',
    startAppServers: true,
    launchAppServer: () => fakeAppServer(restoredCalls),
  });
  await second.listen({ host: '127.0.0.1', port: 0 });
  await expect.poll(() => restoredCalls, { timeout: 1_000 }).toEqual(['initialize', 'skills/list']);
  expect((await second.inject(`/api/sessions/${created.id}`)).json()).toMatchObject({
    threadId: 'thread-1',
    state: 'stopped',
  });
  await second.close();
});

test('uses the original snapshot only when a detached session sends after profile removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-root-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-state-'));
  const homeDirectory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-home-'));
  paths.push(root, dataDir, homeDirectory);
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const profiles = {
    list: async () => [{ name: 'default', state: 'ok' as const, status: 'ready' }],
    require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' }),
  };
  const store = new FilesystemSkillProfileStore(homeDirectory);
  await store.replaceGlobalProfile(
    createSkillProfile({
      name: 'focused',
      skills: [
        { name: 'Alpha', path: '/skills/alpha/SKILL.md', enabled: true },
        { name: 'Beta', path: '/skills/beta/SKILL.md', enabled: false },
      ],
    }),
  );
  let discovered = [
    { name: 'Alpha', description: 'Alpha skill', path: '/skills/alpha/SKILL.md', enabled: false },
    { name: 'Beta', description: 'Beta skill', path: '/skills/beta/SKILL.md', enabled: true },
  ];
  const launches: Array<{
    profile: string;
    cwd: string;
    skillsConfig?: readonly { path: string; enabled: boolean }[];
  }> = [];
  const launchAppServer = (input: {
    profile: string;
    cwd: string;
    skillsConfig?: readonly { path: string; enabled: boolean }[];
  }) => {
    launches.push(input);
    return {
      rpc: {
        request: async (method: string, params: unknown) => {
          if (method === 'model/list') return { data: [{ id: 'gpt-5.6-terra' }] };
          if (method === 'skills/list')
            return {
              data: [
                { cwd: (params as { cwds: string[] }).cwds[0], skills: discovered, errors: [] },
              ],
            };
          if (['thread/start', 'thread/resume'].includes(method))
            return { thread: { id: 'thread-1' } };
          if (method === 'turn/start') return { turn: { id: 'turn-1' } };
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
      onExit: () => () => {},
    };
  };
  const first = await composeRelayApp({
    root,
    dataDir,
    relyingParty,
    homeDirectory,
    profiles,
    installedCodexVersion: 'codex-cli 0.144.3',
    startAppServers: true,
    launchAppServer,
  });
  const workspace = (await first.inject('/api/bootstrap')).json().workspaces[0]?.children[0];
  const created = await first.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { workspaceId: workspace.id, profile: 'default', skillProfile: 'focused' },
  });
  expect(created.statusCode).toBe(202);
  expect(created.json()).toMatchObject({
    effectiveSkillSelection: {
      selectedProfileName: 'focused',
      skills: [
        { name: 'Alpha', path: '/skills/alpha/SKILL.md', enabled: true },
        { name: 'Beta', path: '/skills/beta/SKILL.md', enabled: false },
      ],
    },
  });
  await first.close();

  await rm(store.globalProfilePath('focused'));
  await writeFile(
    join(workspacePath, 'gestalt-skills.yml'),
    serializeSkillProfileYaml(
      createSkillProfile({
        name: 'changed-project',
        skills: [{ name: 'Beta', path: '/skills/beta/SKILL.md', enabled: true }],
      }),
    ),
  );
  discovered = [
    { name: 'Alpha', description: 'Alpha skill', path: '/skills/alpha/SKILL.md', enabled: false },
    { name: 'Beta', description: 'Beta skill', path: '/skills/beta/SKILL.md', enabled: true },
    {
      name: 'New native skill',
      description: 'New skill',
      path: '/skills/new/SKILL.md',
      enabled: true,
    },
  ];
  launches.splice(0);
  const second = await composeRelayApp({
    root,
    dataDir,
    relyingParty,
    homeDirectory,
    profiles,
    installedCodexVersion: 'codex-cli 0.144.3',
    startAppServers: true,
    launchAppServer,
  });
  await second.listen({ host: '127.0.0.1', port: 0 });
  expect(launches.find((launch) => launch.skillsConfig)).toBeUndefined();
  const started = await second.inject({
    method: 'POST',
    url: `/api/sessions/${created.json().id}/turns`,
    payload: { text: 'resume only on send' },
  });
  expect(started.statusCode).toBe(202);
  await expect
    .poll(() => launches.find((launch) => launch.skillsConfig)?.skillsConfig)
    .toEqual([
      { path: '/skills/alpha/SKILL.md', enabled: true },
      { path: '/skills/beta/SKILL.md', enabled: false },
      { path: '/skills/new/SKILL.md', enabled: false },
    ]);
  await second.close();
});
