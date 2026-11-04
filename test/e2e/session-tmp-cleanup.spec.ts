/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type APIResponse } from '@playwright/test';
import { composeRelayApp } from '../../src/server/composition.js';
import type {
  AppServer,
  AppServerLaunchInput,
} from '../../src/server/platform/codex/session-runtime.js';
import { workspaceId } from '../../src/server/platform/catalog/workspace-id.js';
import {
  FilesystemSessionScratch,
  mobileScratchOwnerId,
} from '../../src/server/platform/scratch/filesystem-session-scratch.js';
import { stopOwnedProcessGroup } from '../../src/server/platform/scratch/owned-process-group.js';

const exists = (path: string) =>
  access(path)
    .then(() => true)
    .catch(() => false);

test('protects two workspace rosters, retains Stop scratch and waits for actual exit before Forget deletion', async ({
  request,
}) => {
  const base = join(process.cwd(), 'tmp', 'mobile-scratch-tests');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, 'cleanup-http-'));
  const firstWorkspace = join(root, 'first');
  const secondWorkspace = join(root, 'second');
  await mkdir(firstWorkspace);
  await mkdir(secondWorkspace);
  const children: { child: ChildProcess; directory: string; exited: Promise<unknown> }[] = [];
  const launch = (input: AppServerLaunchInput): AppServer => {
    const locator = input.environment?.GESTALT_SESSION_TMP_CONTEXT;
    const directory = locator ? (JSON.parse(locator) as { directory: string }).directory : null;
    let owned: (typeof children)[number] | undefined;
    if (directory) {
      const script = `const fs=require('node:fs'),path=require('node:path'),root=process.argv[1];
process.on('SIGTERM',()=>{fs.writeFileSync(path.join(root,'stopping'),'yes');setInterval(()=>{if(fs.existsSync(path.join(root,'release')))process.exit(0)},20)});
fs.writeFileSync(path.join(root,'ready'),'yes');setInterval(()=>{},1000);`;
      const child = spawn(process.execPath, ['-e', script, directory], {
        cwd: input.cwd,
        env: { ...input.environment },
        detached: true,
        stdio: 'ignore',
      });
      owned = { child, directory, exited: once(child, 'exit') };
      children.push(owned);
    }
    const threadId = `fixture-thread-${children.length}`;
    let proof: Promise<void> | undefined;
    const close = () => {
      if (owned && owned.child.exitCode === null && owned.child.signalCode === null)
        owned.child.kill('SIGTERM');
    };
    return {
      rpc: {
        request: async (method, params) => {
          if (method === 'model/list') return { data: [{ id: 'gpt-5.6-terra' }] };
          if (method === 'skills/list')
            return {
              data: [{ cwd: (params as { cwds: string[] }).cwds[0], skills: [], errors: [] }],
            };
          if (method === 'thread/start') return { thread: { id: threadId } };
          if (method === 'thread/read')
            return { thread: { id: threadId, turns: [], status: { type: 'idle' } } };
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close,
      closeAndWait: () =>
        (proof ??= (async () => {
          close();
          if (owned) {
            if (!(await stopOwnedProcessGroup(owned.child, 4000, 1000)))
              throw new Error('FIXTURE_RELEASE_UNCONFIRMED');
            await owned.exited;
          }
        })()),
      onExit: (listener) => {
        owned?.child.once('exit', listener);
        return () => {
          owned?.child.off('exit', listener);
        };
      },
    };
  };
  let app: Awaited<ReturnType<typeof composeRelayApp>> | undefined;
  let forgetting: Promise<APIResponse> | undefined;
  try {
    app = await composeRelayApp({
      root,
      dataDir: join(root, '.state'),
      homeDirectory: join(root, '.home'),
      relyingParty: {
        publicOrigin: 'http://localhost',
        rpId: 'localhost',
        rpName: 'Gestalt Mobile',
      },
      passkeyAuthEnabled: false,
      testRunnerEnabled: false,
      installedCodexVersion: 'codex-cli 0.144.3',
      startAppServers: true,
      profiles: {
        list: async () => [{ name: 'default', state: 'ok', status: 'ready' }],
        require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
      },
      launchAppServer: launch,
    });
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const start = async (path: string) => {
      const reply = await request.post(`${url}/api/sessions`, {
        data: {
          workspaceId: workspaceId(path),
          profile: 'default',
          provider: 'codex',
          model: 'gpt-5.6-terra',
        },
      });
      expect(reply.status()).toBe(202);
      return (await reply.json()) as { id: string };
    };
    const first = await start(firstWorkspace);
    const second = await start(secondWorkspace);
    const firstDirectory = join(firstWorkspace, 'tmp', 'sessions', mobileScratchOwnerId(first.id));
    const secondDirectory = join(
      secondWorkspace,
      'tmp',
      'sessions',
      mobileScratchOwnerId(second.id),
    );
    await expect.poll(() => exists(join(firstDirectory, 'ready')), { timeout: 2000 }).toBe(true);
    await expect.poll(() => exists(join(secondDirectory, 'ready')), { timeout: 2000 }).toBe(true);
    await writeFile(join(firstDirectory, 'payload'), 'first');
    await writeFile(join(secondDirectory, 'payload'), 'second');
    const orphan = await new FilesystemSessionScratch().allocate({
      id: 'orphan-fixture',
      workspacePath: secondWorkspace,
    });
    await writeFile(join(orphan.directory, 'payload'), 'orphan');

    await writeFile(join(secondDirectory, 'release'), 'yes');
    expect(
      (await request.post(`${url}/api/sessions/${second.id}/stop`, { data: {} })).status(),
    ).toBe(202);
    expect(await readFile(join(secondDirectory, 'payload'), 'utf8')).toBe('second');
    const cleaned = await request.post(`${url}/api/maintenance/clean-tmp`, { data: {} });
    expect(cleaned.status()).toBe(200);
    const cleanupResult: unknown = await cleaned.json();
    expect(cleanupResult, JSON.stringify(cleanupResult)?.slice(0, 1200)).toMatchObject({
      status: 'complete',
      folders: { removed: 1, skipped: 2, failed: 0 },
      workspaces: { failed: 0, unavailable: 0 },
      reasons: { unsafe: 0, unavailable: 0, io: 0 },
    });
    expect(await exists(orphan.directory)).toBe(false);
    expect(await readFile(join(firstDirectory, 'payload'), 'utf8')).toBe('first');
    expect(await readFile(join(secondDirectory, 'payload'), 'utf8')).toBe('second');

    forgetting = request.delete(`${url}/api/sessions/${first.id}`);
    await expect.poll(() => exists(join(firstDirectory, 'stopping')), { timeout: 2000 }).toBe(true);
    expect(
      (await request.get(`${url}/api/sessions/${first.id}`).then((reply) => reply.json()))
        .forgetOperation.phase,
    ).toBe('stopping');
    expect(await readFile(join(firstDirectory, 'payload'), 'utf8')).toBe('first');
    expect(
      (await request.post(`${url}/api/sessions/${first.id}/restore`, { data: {} })).status(),
    ).toBe(409);
    expect((await request.get(`${url}/api/sessions/${second.id}`)).status()).toBe(200);
    await writeFile(join(firstDirectory, 'release'), 'yes');
    expect((await forgetting).status()).toBe(204);
    expect(await exists(firstDirectory)).toBe(false);
    expect((await request.get(`${url}/api/sessions/${first.id}`)).status()).toBe(404);
    expect(await readFile(join(secondDirectory, 'payload'), 'utf8')).toBe('second');
  } finally {
    await Promise.allSettled(
      children.map(async (owned) => {
        if (owned.child.exitCode === null && owned.child.signalCode === null) {
          await writeFile(join(owned.directory, 'release'), 'yes').catch(() => undefined);
          if (
            !(await stopOwnedProcessGroup(owned.child, 200, 1000)) &&
            owned.child.exitCode === null &&
            owned.child.signalCode === null
          )
            owned.child.kill('SIGKILL');
        }
        await owned.exited;
      }),
    );
    await Promise.allSettled(forgetting ? [forgetting] : []);
    try {
      await app?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
