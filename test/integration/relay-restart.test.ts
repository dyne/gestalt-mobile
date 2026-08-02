/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { composeRelayApp } from '../../src/server/composition.js';

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
function fakeAppServer(calls: string[]) {
  return {
    rpc: {
      request: async (method: string, params: unknown) => {
        calls.push(method);
        if (method === 'model/list') return { data: [{ id: 'gpt-5.6-terra' }] };
        if (method === 'skills/list')
          return { data: [{ cwd: (params as { cwds: string[] }).cwds[0], skills: [], errors: [] }] };
        return method === 'thread/start' ? { thread: { id: 'thread-1' } } : {};
      },
      onNotification: () => () => {},
      onServerRequest: () => () => {},
    },
    close: () => {},
    onExit: () => () => {},
  };
}
test('restores a persisted thread after an HTTP relay restart', async () => {
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
  const bootstrap = await fetch(`${base}/api/bootstrap`).then(
    (response) => response.json() as Promise<{ workspaces: WorkspaceOption[] }>,
  );
  const workspace = bootstrap.workspaces[0]?.children[0];
  expect(bootstrap.workspaces).toMatchObject([
    {
      relativePath: '.',
      children: [{ id: workspace?.id, name: 'workspace', relativePath: 'workspace' }],
    },
  ]);
  const created = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
  await expect.poll(() => restoredCalls, { timeout: 1_000 }).toEqual([
    'initialize', 'skills/list', 'initialize', 'skills/list', 'initialize', 'thread/resume',
  ]);
  expect((await second.inject(`/api/sessions/${created.id}`)).json()).toMatchObject({
    threadId: 'thread-1',
    state: 'ready',
  });
  await second.close();
});

test('restores the original snapshot after profile removal and fresh catalog changes', async () => {
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
  await store.replaceGlobalProfile(createSkillProfile({
    name: 'focused',
    skills: [
      { name: 'Alpha', path: '/skills/alpha/SKILL.md', enabled: true },
      { name: 'Beta', path: '/skills/beta/SKILL.md', enabled: false },
    ],
  }));
  let discovered = [
    { name: 'Alpha', description: 'Alpha skill', path: '/skills/alpha/SKILL.md', enabled: false },
    { name: 'Beta', description: 'Beta skill', path: '/skills/beta/SKILL.md', enabled: true },
  ];
  const launches: Array<{ profile: string; cwd: string; skillsConfig?: readonly { path: string; enabled: boolean }[] }> = [];
  const launchAppServer = (input: { profile: string; cwd: string; skillsConfig?: readonly { path: string; enabled: boolean }[] }) => {
    launches.push(input);
    return {
      rpc: {
        request: async (method: string, params: unknown) => {
          if (method === 'model/list') return { data: [{ id: 'gpt-5.6-terra' }] };
          if (method === 'skills/list')
            return { data: [{ cwd: (params as { cwds: string[] }).cwds[0], skills: discovered, errors: [] }] };
          return method === 'thread/start' ? { thread: { id: 'thread-1' } } : {};
        },
        onNotification: () => () => {}, onServerRequest: () => () => {},
      },
      close: () => {}, onExit: () => () => {},
    };
  };
  const first = await composeRelayApp({
    root, dataDir, relyingParty, homeDirectory, profiles, installedCodexVersion: 'codex-cli 0.144.3',
    startAppServers: true, launchAppServer,
  });
  const workspace = (await first.inject('/api/bootstrap')).json().workspaces[0]?.children[0];
  const created = await first.inject({
    method: 'POST', url: '/api/sessions',
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
  await writeFile(join(workspacePath, 'gestalt-skills.yml'), serializeSkillProfileYaml(createSkillProfile({
    name: 'changed-project', skills: [{ name: 'Beta', path: '/skills/beta/SKILL.md', enabled: true }],
  })));
  discovered = [
    { name: 'Alpha', description: 'Alpha skill', path: '/skills/alpha/SKILL.md', enabled: false },
    { name: 'Beta', description: 'Beta skill', path: '/skills/beta/SKILL.md', enabled: true },
    { name: 'New native skill', description: 'New skill', path: '/skills/new/SKILL.md', enabled: true },
  ];
  launches.splice(0);
  const second = await composeRelayApp({
    root, dataDir, relyingParty, homeDirectory, profiles, installedCodexVersion: 'codex-cli 0.144.3',
    startAppServers: true, launchAppServer,
  });
  await second.listen({ host: '127.0.0.1', port: 0 });
  await expect.poll(() => launches.find((launch) => launch.skillsConfig)?.skillsConfig).toEqual([
    { path: '/skills/alpha/SKILL.md', enabled: true },
    { path: '/skills/beta/SKILL.md', enabled: false },
    { path: '/skills/new/SKILL.md', enabled: false },
  ]);
  await second.close();
});
