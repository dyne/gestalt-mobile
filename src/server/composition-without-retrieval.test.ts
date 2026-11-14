/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { composeRelayApp } from './composition.js';
import { createRelyingPartyConfig } from './config.js';
import { FilesystemSessionScratch } from './platform/scratch/filesystem-session-scratch.js';

it('composes discovery and shutdown without a retrieval installation or service lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mobile-retirement-'));
  const launch = vi.fn(() => {
    throw new Error('Passive discovery must not launch a provider');
  });
  const serviceLease = vi.spyOn(FilesystemSessionScratch.prototype, 'allocateService');
  const app = await composeRelayApp({
    root,
    dataDir: join(root, 'state'),
    homeDirectory: join(root, 'home'),
    relyingParty: createRelyingPartyConfig('http://localhost'),
    passkeyAuthEnabled: false,
    profiles: {
      list: async () => [],
      require: async () => {
        throw new Error('PROFILE_NOT_FOUND');
      },
    },
    installedCodexVersion: null,
    launchAppServer: launch,
  });
  try {
    await app.ready();
    const response = await app.inject('/api/bootstrap');
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('xerj');
    expect(response.json().versions).not.toContainEqual(expect.objectContaining({ id: 'xerj' }));
    expect((await app.inject('/api/xerj')).statusCode).toBe(404);
    expect(await readdir(root)).not.toContain('.xerjignore');
    expect(launch).not.toHaveBeenCalled();
    expect(serviceLease).not.toHaveBeenCalled();
  } finally {
    await app.close();
    serviceLease.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('starts, sends, reopens readable history, restores, stops and quits without retrieval artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mobile-without-retrieval-'));
  const root = join(directory, 'workspaces');
  const workspace = join(root, 'project');
  const home = join(directory, 'home');
  const emptyBin = join(directory, 'empty-bin');
  await mkdir(workspace, { recursive: true });
  await mkdir(home);
  await mkdir(emptyBin);
  await writeFile(join(home, 'preserved-user-data'), 'keep');
  vi.stubEnv('PATH', emptyBin);
  vi.stubEnv('CODEX_HOME', home);
  vi.stubEnv('GESTALT_HOME', join(home, 'manager'));
  vi.stubEnv('GESTALT_MANAGER_BIN', '');
  const requests: Array<{ method: string; params: unknown }> = [];
  const serviceLease = vi.spyOn(FilesystemSessionScratch.prototype, 'allocateService');
  const close = vi.fn();
  const options = {
    root,
    dataDir: join(directory, 'state'),
    homeDirectory: home,
    relyingParty: createRelyingPartyConfig('http://localhost'),
    passkeyAuthEnabled: false,
    testRunnerEnabled: false,
    installedCodexVersion: 'fixture',
    startAppServers: true,
    profiles: {
      list: async () => [],
      require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' as const }),
    },
    launchAppServer: () => ({
      rpc: {
        request: async (method: string, params: unknown) => {
          requests.push({ method, params });
          if (method === 'model/list') return { data: [{ id: 'fixture' }] };
          if (method === 'skills/list')
            return {
              data: [{ cwd: (params as { cwds: string[] }).cwds[0], skills: [], errors: [] }],
            };
          if (method === 'config/read')
            return { config: { mcp_servers: {}, features: { hooks: true } } };
          if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/read')
            return {
              thread: {
                id: 'durable-without-retrieval',
                cwd: workspace,
                status: { type: 'idle' },
                turns: [
                  {
                    id: 'history-turn',
                    status: 'completed',
                    items: [
                      {
                        id: 'saved-answer',
                        type: 'agentMessage',
                        text: 'Saved history remains readable.',
                        phase: 'final_answer',
                      },
                    ],
                  },
                ],
              },
            };
          if (method === 'turn/start') return { turn: { id: 'sent-turn' } };
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close,
      closeAndWait: async () => {
        close();
      },
      onExit: () => () => {},
    }),
  };
  let app: Awaited<ReturnType<typeof composeRelayApp>> | undefined;
  const headers = { origin: 'http://localhost' };
  try {
    expect(await readdir(emptyBin)).toEqual([]);
    app = await composeRelayApp(options);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const bootstrap = (await app.inject('/api/bootstrap')).json();
    expect(bootstrap).not.toHaveProperty('xerj');
    const selected = bootstrap.workspaces[0].children.find(
      (entry: { name: string }) => entry.name === 'project',
    );
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: { workspaceId: selected.id, profile: 'default', provider: 'codex' },
    });
    expect(created.statusCode, created.body).toBe(202);
    const id = created.json().id as string;
    const thread = created.json().threadId;
    const send = async () => {
      const response = await app!.inject({
        method: 'POST',
        url: `/api/sessions/${id}/turns`,
        headers,
        payload: { text: 'Fixture request' },
      });
      expect(response.statusCode, response.body).toBe(202);
    };
    const stop = async () => {
      const response = await app!.inject({
        method: 'POST',
        url: `/api/sessions/${id}/stop`,
        headers,
      });
      expect(response.statusCode, response.body).toBe(202);
    };
    await send();
    await stop();
    await app.close();
    app = await composeRelayApp(options);
    let closed = false;
    app.addHook('onClose', async () => {
      closed = true;
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const turnsBeforeRead = requests.filter(({ method }) => method === 'turn/start').length;
    const history = await app.inject(`/api/sessions/${id}/history`);
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().items).toContainEqual(
      expect.objectContaining({ text: 'Saved history remains readable.' }),
    );
    expect(requests.filter(({ method }) => method === 'turn/start')).toHaveLength(turnsBeforeRead);
    const saved = (await app.inject(`/api/sessions/${id}`)).json();
    expect(saved.threadId).toBe(thread);
    expect(saved.state).toBe('stopped');
    const resumesBeforeRestore = requests.filter(({ method }) => method === 'thread/resume').length;
    const restored = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/restore`,
      headers,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toMatchObject({ state: 'ready', threadId: thread });
    expect(requests.filter(({ method }) => method === 'thread/resume')).toHaveLength(
      resumesBeforeRestore + 1,
    );
    await send();
    await stop();
    expect(
      (await app.inject({ method: 'POST', url: '/api/maintenance/quit', headers })).statusCode,
    ).toBe(202);
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(serviceLease).not.toHaveBeenCalled();
    expect(JSON.stringify(requests)).not.toMatch(/xerj/i);
    expect(await readdir(workspace)).not.toContain('.xerjignore');
    expect(await readdir(home)).not.toContain('xerj-data');
    expect(await readFile(join(home, 'preserved-user-data'), 'utf8')).toBe('keep');
    expect(close).toHaveBeenCalled();
  } finally {
    await app?.close();
    serviceLease.mockRestore();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
