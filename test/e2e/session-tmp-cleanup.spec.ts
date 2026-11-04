/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
import { buildApp } from '../../src/server/app.js';
import { CleanSessionScratch } from '../../src/server/features/sessions/clean-tmp/use-case.js';
import {
  RelaySession,
  type SessionState,
} from '../../src/server/features/sessions/model/relay-session.js';
import { FilesystemScratchCleanup } from '../../src/server/platform/scratch/filesystem-scratch-cleanup.js';
import { SqliteSessionRepository } from '../../src/server/platform/persistence/sqlite-session-repository.js';
import { migrate } from '../../src/server/platform/persistence/migrate.js';
import type { CleanTmpResult } from '../../src/shared/contracts/tmp-cleanup.js';

const exists = (path: string) =>
  access(path)
    .then(() => true)
    .catch(() => false);

test('protects two workspace rosters, retains Stop scratch and waits for actual exit before Forget deletion', async ({
  request,
  page,
}) => {
  test.setTimeout(60_000);
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
            if (!(await stopOwnedProcessGroup(owned.child, 20_000, 1000)))
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
      staticDir: resolve('dist/client'),
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
    const firstOrphan = await new FilesystemSessionScratch().allocate({
      id: 'first-workspace-orphan',
      workspacePath: firstWorkspace,
    });
    await writeFile(join(firstOrphan.directory, 'payload'), 'first orphan');

    await writeFile(join(secondDirectory, 'release'), 'yes');
    expect(
      (await request.post(`${url}/api/sessions/${second.id}/stop`, { data: {} })).status(),
    ).toBe(202);
    expect(await readFile(join(secondDirectory, 'payload'), 'utf8')).toBe('second');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await page.getByRole('button', { name: 'Open configuration', exact: true }).click();
    const cleanupReply = page.waitForResponse(
      (response) =>
        response.url() === `${url}/api/maintenance/clean-tmp` &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Clean TMP', exact: true }).click();
    const cleaned = await cleanupReply;
    expect(cleaned.status()).toBe(200);
    const cleanupResult: unknown = await cleaned.json();
    expect(cleanupResult, JSON.stringify(cleanupResult)?.slice(0, 1200)).toMatchObject({
      status: 'complete',
      folders: { removed: 2, skipped: 2, failed: 0 },
      workspaces: { removed: 2, failed: 0, unavailable: 0 },
      reasons: { unsafe: 0, unavailable: 0, io: 0 },
    });
    expect((cleanupResult as CleanTmpResult).reasons).toEqual({
      protected: 1,
      busy: 0,
      lease: 1,
      unrecognized: 0,
      unsafe: 0,
      unavailable: 0,
      io: 0,
    });
    expect(await exists(orphan.directory)).toBe(false);
    expect(await exists(firstOrphan.directory)).toBe(false);
    await expect(page.locator('.toast')).toContainText(
      'Removed 2 temporary folders in 2 workspaces. Kept 1 protected folder. Skipped 1 other folder.',
    );
    expect(await readFile(join(firstDirectory, 'payload'), 'utf8')).toBe('first');
    expect(await readFile(join(secondDirectory, 'payload'), 'utf8')).toBe('second');

    // Exercise the shipped client against production HTTP composition and a
    // genuinely held owned child, rather than replacing the operation with a UI mock.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await page.getByRole('button', { name: 'Sessions', exact: true }).click();
    const firstFrame = page.locator(`[data-session-id="${first.id}"]`);
    const secondFrame = page.locator(`[data-session-id="${second.id}"]`);
    await expect(firstFrame).toBeVisible();

    forgetting = request.delete(`${url}/api/sessions/${first.id}`);
    await expect.poll(() => exists(join(firstDirectory, 'stopping')), { timeout: 2000 }).toBe(true);
    expect(
      (await request.get(`${url}/api/sessions/${first.id}`).then((reply) => reply.json()))
        .forgetOperation.phase,
    ).toBe('stopping');
    const bootstrap = await request.get(`${url}/api/bootstrap`).then((reply) => reply.json());
    expect(
      bootstrap.sessions.find((session: { id: string }) => session.id === first.id).forgetOperation
        .phase,
    ).toBe('stopping');
    await expect(firstFrame).toHaveAttribute('aria-busy', 'true');
    await expect(firstFrame.getByRole('status')).toContainText('Forgetting session…');
    await expect(firstFrame.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
    await expect(secondFrame.getByRole('button', { name: 'Open', exact: true })).toBeEnabled();
    await page.reload();
    await expect(firstFrame).toHaveAttribute('aria-busy', 'true');
    await expect(firstFrame.getByRole('status')).toContainText('Forgetting session…');
    expect(await readFile(join(firstDirectory, 'payload'), 'utf8')).toBe('first');
    expect(
      (await request.post(`${url}/api/sessions/${first.id}/restore`, { data: {} })).status(),
    ).toBe(409);
    expect((await request.get(`${url}/api/sessions/${second.id}`)).status()).toBe(200);
    await writeFile(join(firstDirectory, 'release'), 'yes');
    expect((await forgetting).status()).toBe(204);
    expect(await exists(firstDirectory)).toBe(false);
    expect((await request.get(`${url}/api/sessions/${first.id}`)).status()).toBe(404);
    await expect(firstFrame).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Recent sessions' })).toContainText('/first');
    expect(await readFile(join(secondDirectory, 'payload'), 'utf8')).toBe('second');
  } finally {
    await page.close();
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

test('Clean TMP HTTP preserves every durable roster state across two workspaces and distinguishes verified legacy, ambiguous, empty and partial results', async ({
  request,
}, testInfo) => {
  const base = join(process.cwd(), 'tmp', 'mobile-scratch-tests');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, 'cleanup-lifecycle-'));
  const first = join(root, 'first');
  const second = join(root, 'second');
  await mkdir(first);
  await mkdir(second);
  const db = new DatabaseSync(join(root, 'relay.sqlite'));
  migrate(db);
  const sessions = new SqliteSessionRepository(db);
  const paths = [first, second];
  let discoveryFailed = false;
  const cleanup = new CleanSessionScratch({
    sessions: () => sessions.list(),
    knownWorkspacePaths: async () => [...paths, ...sessions.knownWorkspacePaths()],
    additionalWorkspacePaths: async () => {
      if (discoveryFailed) throw new Error('fixture discovery unavailable');
      return [];
    },
    storage: new FilesystemScratchCleanup(),
  });
  // Normal production HTTP registration with actual SQLite roster and filesystem
  // adapters. Only workspace discovery failure is controlled by this fixture.
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const observations: Array<{ phase: string; result: CleanTmpResult }> = [];
  try {
    app = await buildApp({
      health: { read: async () => ({ status: 'ok' }) } as never,
      logger: console,
      passkeyAuthDisabled: true,
      tmpCleanup: cleanup,
    });
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const clean = async (phase: string) => {
      const reply = await request.post(`${url}/api/maintenance/clean-tmp`, { data: {} });
      expect(reply.status()).toBe(200);
      const result = (await reply.json()) as CleanTmpResult;
      observations.push({ phase, result });
      return result;
    };
    expect(await clean('empty')).toMatchObject({
      status: 'complete',
      folders: { removed: 0, skipped: 0, failed: 0 },
      workspaces: { cleaned: 2, removed: 0, unavailable: 0 },
    });
    const scratch = new FilesystemSessionScratch();
    const owners: Array<{ id: string; directory: string; state: SessionState }> = [];
    for (const [index, state] of (
      ['ready', 'turnActive', 'stopped', 'released'] as const
    ).entries()) {
      const id = `protected-${state}`;
      const workspacePath = index % 2 ? second : first;
      const snapshot = {
        ...RelaySession.create({
          id,
          workspaceId: workspaceId(workspacePath),
          workspacePath,
          provider: 'codex',
          profile: 'default',
          effectiveSkillSelection: { skills: [] },
          now: '2026-11-04T10:00:00.000Z',
        }).snapshot,
        state,
        desiredState:
          state === 'stopped' || state === 'released' ? ('stopped' as const) : ('active' as const),
        threadId: `thread-${id}`,
      };
      sessions.save(snapshot);
      const context = await scratch.allocate(snapshot);
      await writeFile(join(context.directory, 'protected-payload'), state);
      owners.push({ id, directory: context.directory, state });
    }
    const orphan = await scratch.allocate({ id: 'orphan-new', workspacePath: first });
    await writeFile(join(orphan.directory, 'payload'), 'eligible');
    const producer = await readFile(
      join(process.cwd(), 'test/fixtures/scratch/mobile-v1-producer.ts.txt'),
      'utf8',
    );
    expect(createHash('sha256').update(producer).digest('hex')).toBe(
      '889e8b7785b6e18a8ff51b17c3d01f3992bcb8ea0f7724d616be31cd613ef916',
    );
    const source = join(root, 'historical-producer.ts');
    await writeFile(source, producer);
    const legacyId = 'orphan-historical';
    const legacy = join(second, 'tmp', 'sessions', mobileScratchOwnerId(legacyId));
    await promisify(execFile)(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `const {FilesystemSessionScratch}=await import(${JSON.stringify(pathToFileURL(source).href)});await new FilesystemSessionScratch().allocate(JSON.parse(process.argv[1]));`,
        JSON.stringify({ id: legacyId, workspacePath: second }),
      ],
      { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeout: 5000 },
    );
    await writeFile(join(legacy, 'historical-payload'), 'eligible historical allocation');
    const ambiguous = join(first, 'tmp', '.ctx-mode-ambiguous');
    await mkdir(ambiguous, { mode: 0o700 });
    await writeFile(join(ambiguous, 'keep'), 'unattributed');
    const persistent = join(second, 'source.txt');
    await writeFile(persistent, 'source remains');
    expect(await clean('two-workspace-legacy-and-protected')).toMatchObject({
      status: 'complete',
      folders: { removed: 2, skipped: 5, failed: 0 },
      workspaces: { removed: 2, skipped: 2, failed: 0, unavailable: 0 },
      reasons: { protected: 4, unrecognized: 1, unsafe: 0, io: 0 },
    });
    expect(await exists(orphan.directory)).toBe(false);
    expect(await exists(legacy)).toBe(false);
    for (const owner of owners) {
      expect(await readFile(join(owner.directory, 'protected-payload'), 'utf8')).toBe(owner.state);
      expect(sessions.find(owner.id)?.threadId).toBe(`thread-${owner.id}`);
    }
    expect(await readFile(join(ambiguous, 'keep'), 'utf8')).toBe('unattributed');
    expect(await readFile(persistent, 'utf8')).toBe('source remains');
    expect(await clean('repeat-protected')).toMatchObject({
      status: 'complete',
      folders: { removed: 0, skipped: 5, failed: 0 },
      reasons: { protected: 4, unrecognized: 1 },
    });
    const partialOwner = await scratch.allocate({ id: 'partial-orphan', workspacePath: first });
    paths.push(join(root, 'unavailable-workspace'));
    expect(await clean('unavailable-workspace-with-removal')).toMatchObject({
      status: 'partial',
      folders: { removed: 1, skipped: 5, failed: 0 },
      workspaces: { removed: 1, unavailable: 1 },
      reasons: { unavailable: 1 },
    });
    expect(await exists(partialOwner.directory)).toBe(false);
    paths.pop();
    discoveryFailed = true;
    expect(await clean('discovery-only-partial')).toMatchObject({
      status: 'partial',
      folders: { removed: 0, skipped: 5, failed: 0 },
      workspaces: { unavailable: 0 },
      reasons: { unavailable: 1 },
    });
    for (const owner of owners) expect(await exists(owner.directory)).toBe(true);
  } finally {
    try {
      await testInfo.attach('real-cleanup-observations', {
        body: JSON.stringify(observations),
        contentType: 'application/json',
      });
    } finally {
      try {
        await app?.close();
      } finally {
        db.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});
