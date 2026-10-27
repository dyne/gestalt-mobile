/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, onTestFinished, vi } from 'vitest';
import { composeRelayApp } from './composition.js';
const exec = promisify(execFile);

it.each([false, true])(
  'uses runtime workspace suites by default and honors opt-out (disabled: %s)',
  async (disabled) => {
    const base = await mkdtemp(join(tmpdir(), 'composed-host-tests-'));
    onTestFinished(() => rm(base, { recursive: true, force: true }));
    const root = base,
      repository = join(root, 'workspace');
    await mkdir(repository, { recursive: true });
    await writeFile(join(repository, 'test.cjs'), "console.log('host fixture');");
    await exec('git', ['init', '-q', repository]);
    await exec('git', ['add', '.'], { cwd: repository });
    await exec(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'fixture',
      ],
      { cwd: repository },
    );
    const config = join(repository, '.gestalt/host-tests.json');
    const writeConfig = async () => {
      await mkdir(join(repository, '.gestalt'), { recursive: true });
      await writeFile(
        config,
        JSON.stringify({
          version: 1,
          suites: [
            {
              id: 'full',
              repository,
              command: process.execPath,
              args: ['test.cjs'],
              timeoutMs: 5000,
              maxOutputBytes: 4096,
            },
          ],
        }),
        { mode: 0o600 },
      );
    };
    type Request = { id: number; method: string; params: unknown };
    let dispatch: ((request: Request) => Promise<unknown>) | undefined;
    let tools: Array<{ name: string }> = [];
    const app = await composeRelayApp({
      root,
      dataDir: join(base, 'state'),
      homeDirectory: join(base, 'home'),
      ...(disabled ? { testRunnerEnabled: false } : {}),
      passkeyAuthEnabled: false,
      xerj: 'off',
      relyingParty: {
        publicOrigin: 'http://localhost:3000',
        rpId: 'localhost',
        rpName: 'Gestalt Mobile',
      },
      installedCodexVersion: 'codex-cli 0.164.0',
      startAppServers: true,
      profiles: {
        list: async () => [],
        require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
      },
      launchAppServer: () => ({
        rpc: {
          request: async (method, params) => {
            if (method === 'thread/start') {
              tools = (params as { dynamicTools: typeof tools }).dynamicTools;
              return { thread: { id: 'host-root' } };
            }
            if (method === 'model/list') return { data: [{ id: 'fixture' }] };
            if (method === 'skills/list')
              return { data: [{ cwd: repository, skills: [], errors: [] }] };
            if (method === 'thread/read')
              return { thread: { id: 'host-root', status: { type: 'idle' }, turns: [] } };
            return {};
          },
          onNotification: () => () => {},
          onServerRequest: (listener) => {
            dispatch = listener;
            return () => {};
          },
        },
        close: () => {},
        onExit: () => () => {},
      }),
    });
    onTestFinished(() => app.close());
    const bootstrap = (await app.inject('/api/bootstrap')).json();
    const workspace = bootstrap.workspaces[0].children.find(
      (entry: { name: string }) => entry.name === 'workspace',
    );
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { origin: 'http://localhost:3000' },
      payload: { workspaceId: workspace.id, profile: 'default', provider: 'codex' },
    });
    expect(created.statusCode).toBe(202);
    const sessionId = created.json().id;
    await vi.waitFor(async () =>
      expect((await app.inject('/api/sessions/' + sessionId)).json().state).toBe('ready'),
    );
    expect(tools.some((tool) => tool.name === 'gestalt_test_runner')).toBe(true);
    let id = 0;
    const call = async (args: unknown) => {
      const response = (await dispatch!({
        id: ++id,
        method: 'item/tool/call',
        params: { threadId: 'host-root', tool: 'gestalt_test_runner', arguments: args },
      })) as { contentItems: Array<{ text: string }> };
      return JSON.parse(response.contentItems[0].text);
    };
    if (disabled) {
      await writeConfig();
      expect(await call({ operation: 'list' })).toEqual({ error: 'hostTestRunnerDisabled' });
      return;
    }
    expect(await call({ operation: 'list' })).toEqual({ suites: [] });
    await writeConfig();
    expect(await call({ operation: 'list' })).toMatchObject({ suites: [{ id: 'full' }] });
    expect(
      await call({
        operation: 'start',
        suite: 'full',
        requestId: randomUUID(),
        command: 'override',
      }),
    ).toEqual({ error: 'invalidRequest' });
    const run = await call({
      operation: 'start',
      suite: 'full',
      requestId: randomUUID(),
    });
    expect(run.state).toBe('running');
    await vi.waitFor(
      async () =>
        expect((await call({ operation: 'status', runId: run.runId })).state).toBe('passed'),
      { timeout: 5000 },
    );
  },
  15000,
);
