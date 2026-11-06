/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { ForgetSession } from './use-case.js';
import { registerForgetSession } from './endpoint.js';
import { RelaySession } from '../model/relay-session.js';
import { promoteRecentThread } from '../promote-recent-thread/use-case.js';
import { migrate } from '../../../platform/persistence/migrate.js';
import { SqliteSessionRepository } from '../../../platform/persistence/sqlite-session-repository.js';
import { SqliteForgetOperationStore } from '../../../platform/persistence/sqlite-forget-operation-store.js';
import { FilesystemSessionScratch } from '../../../platform/scratch/filesystem-session-scratch.js';
import { FilesystemScratchCleanup } from '../../../platform/scratch/filesystem-scratch-cleanup.js';
import { stopOwnedProcessGroup } from '../../../platform/scratch/owned-process-group.js';
import { CodexSessionRuntime, type AppServer } from '../../../platform/codex/session-runtime.js';
import type { ForgetPhase } from '../../../../shared/contracts/session-forget.js';

const gates = vi.hoisted(() => ({
  remove: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await gates.remove?.(String(args[0]));
      return actual.rm(...args);
    },
  };
});

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  gates.remove = undefined;
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function barrier(entered: Promise<unknown>, running: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      running.then(() => {
        throw new Error('operation ended before barrier');
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('barrier timed out')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture() {
  const base = join(process.cwd(), 'tmp', 'mobile-scratch-tests');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, 'forget-fixture-'));
  roots.push(root);
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const databasePath = join(root, 'relay.sqlite');
  const db = new DatabaseSync(databasePath);
  databases.push(db);
  migrate(db);
  const sessions = new SqliteSessionRepository(db);
  const operations = new SqliteForgetOperationStore(db);
  const scratch = new FilesystemSessionScratch((id) => operations.assertAvailable(id));
  const cleanup = new FilesystemScratchCleanup();
  const session = {
    ...RelaySession.create({
      id: 'relay-1',
      workspaceId: 'w',
      workspacePath,
      provider: 'codex',
      profile: 'default',
      effectiveSkillSelection: { skills: [] },
      now: '2026-01-01T00:00:00.000Z',
    }).snapshot,
    threadId: 'provider-history',
    state: 'ready' as const,
  };
  sessions.save(session);
  const context = await scratch.allocate(session);
  await writeFile(join(context.directory, 'payload'), 'scratch');
  const phases: ForgetPhase[] = [];
  const make = (release = async () => {}, clean?: () => Promise<void>, store = operations) =>
    new ForgetSession({
      operations: store,
      find: (id) => sessions.find(id),
      release,
      clean: (owner, operationId) =>
        clean
          ? clean()
          : cleanup.cleanSession(
              owner,
              () => {
                const current = store.find(owner.id);
                return current?.operationId === operationId && current.phase === 'cleaning';
              },
              () => sessions.list(),
            ),
      changed: (operation) => {
        phases.push(operation.phase);
      },
      now: () => new Date().toISOString(),
    });
  return {
    root,
    workspacePath,
    databasePath,
    db,
    sessions,
    operations,
    scratch,
    cleanup,
    session,
    context,
    phases,
    make,
  };
}

describe('durable Forget orchestration', () => {
  it('forgets npm-style scratch symlinks without following external, dangling or cyclic targets', async () => {
    const f = await fixture();
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'keep'), 'persistent');
    const modules = join(f.context.directory, 'node_modules');
    await mkdir(join(modules, '.bin'), { recursive: true });
    await writeFile(join(modules, 'tool.js'), 'disposable');
    await symlink('../tool.js', join(modules, '.bin', 'tool'));
    await symlink(outside, join(f.context.directory, 'external-directory'));
    await symlink(join(outside, 'keep'), join(f.context.directory, 'external-file'));
    await symlink(join(outside, 'missing'), join(f.context.directory, 'dangling'));
    await symlink('.', join(f.context.directory, 'cycle'));
    const forget = f.make();
    const app = fastify();
    registerForgetSession(app, {
      find: (id) => f.sessions.find(id),
      forget: (id) => forget.execute(id),
    });
    try {
      const reply = await app.inject({ method: 'DELETE', url: `/api/sessions/${f.session.id}` });
      expect(reply.statusCode, reply.body).toBe(204);
      expect(f.operations.find(f.session.id)?.phase).toBe('completed');
      expect(f.sessions.find(f.session.id)).toBeNull();
      await expect(lstat(f.context.directory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('persistent');
      await expect(lstat(join(outside, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await app.close();
      await forget.drain();
    }
  });

  it('keeps outer Forget retryable with503 while another durable inner workspace is protected', async () => {
    const f = await fixture();
    const workspacePath = join(f.context.directory, 'selected-workspace');
    await mkdir(workspacePath);
    const inner = { ...f.session, id: 'inner-saved', workspacePath, state: 'released' as const };
    f.sessions.save(inner);
    // No inner scratch marker: only the fresh durable workspace association
    // can protect these files from the outer targeted deletion.
    const payload = join(workspacePath, 'source');
    await writeFile(payload, 'saved-inner');
    const forget = f.make();
    const app = fastify();
    registerForgetSession(app, {
      find: (id) => f.sessions.find(id),
      forget: (id) => forget.execute(id),
    });
    try {
      const first = await app.inject({ method: 'DELETE', url: `/api/sessions/${f.session.id}` });
      expect(first.statusCode, first.body).toBe(503);
      expect(first.json()).toMatchObject({
        code: 'SESSION_FORGET_FAILED',
        operation: { phase: 'failed', failureCode: 'SESSION_CLEANUP_FAILED' },
      });
      const retry = await app.inject({ method: 'DELETE', url: `/api/sessions/${f.session.id}` });
      expect(retry.statusCode).toBe(503);
      expect(retry.json().operation.operationId).toBe(first.json().operation.operationId);
      expect(f.sessions.find(f.session.id)).not.toBeNull();
      expect(f.sessions.find(inner.id)).not.toBeNull();
      expect(await readFile(payload, 'utf8')).toBe('saved-inner');
    } finally {
      await app.close();
      await forget.drain();
    }
  });

  it('requires absence of a known detached child after termination acknowledgement', async () => {
    const f = await fixture();
    let present = true;
    const process: AppServer = {
      rpc: {
        request: async (method) => {
          if (method === 'thread/start') return { thread: { id: 'provider-history' } };
          if (method === 'thread/backgroundTerminals/list')
            return { data: present ? [{ processId: 'p1', itemId: 'i1' }] : [] };
          if (method === 'thread/backgroundTerminals/terminate') return { terminated: true };
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
      closeAndWait: async () => {},
    };
    const args: ConstructorParameters<typeof CodexSessionRuntime> = [() => process];
    args[15] = f.scratch;
    const runtime = new CodexSessionRuntime(...args);
    const started = await runtime.start(
      { ...f.session, threadId: null, state: 'starting' },
      '2026-01-01T00:00:00.000Z',
    );
    await runtime.inspectChildProcesses(started, { id: 'child', taskPath: '/root/child' });
    try {
      const forget = f.make(() => runtime.releaseForForget(f.session));
      expect(await forget.execute(f.session.id)).toMatchObject({
        phase: 'failed',
        failureCode: 'SESSION_RELEASE_UNCONFIRMED',
      });
      expect(await readFile(join(f.context.directory, 'payload'), 'utf8')).toBe('scratch');
      present = false;
      expect(await forget.execute(f.session.id)).toMatchObject({ phase: 'completed' });
    } finally {
      runtime.stopAll();
      await runtime.drainReleases();
    }
  });

  it('keeps scratch across ordinary release and waits for runtime confirmation during Forget', async () => {
    const f = await fixture();
    const exit = latch();
    let confirmed = false;
    const process: AppServer = {
      rpc: {
        request: async (method) =>
          method === 'thread/start' ? { thread: { id: 'provider-history' } } : {},
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
      closeAndWait: async () => {
        await exit.wait;
        confirmed = true;
      },
    };
    const args: ConstructorParameters<typeof CodexSessionRuntime> = [() => process];
    args[15] = f.scratch;
    const runtime = new CodexSessionRuntime(...args);
    await runtime.start(
      { ...f.session, threadId: null, state: 'starting' },
      '2026-01-01T00:00:00.000Z',
    );
    await runtime.release(f.session.id);
    expect(await readFile(join(f.context.directory, 'payload'), 'utf8')).toBe('scratch');
    const entered = latch();
    const forget = f.make(async () => {
      entered.release();
      await runtime.releaseForForget(f.session);
    });
    const running = forget.execute(f.session.id);
    try {
      await barrier(entered.wait, running);
      expect(confirmed).toBe(false);
      expect(f.sessions.find(f.session.id)).not.toBeNull();
    } finally {
      exit.release();
      await running;
      await runtime.drainReleases();
    }
    expect((await running)?.phase).toBe('completed');
    expect(confirmed).toBe(true);
  });

  it('rejects missing runtime release proof and keeps the durable lease protected', async () => {
    const f = await fixture();
    const process: AppServer = {
      rpc: {
        request: async (method) =>
          method === 'thread/start' ? { thread: { id: 'provider-history' } } : {},
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      },
      close: () => {},
    };
    const args: ConstructorParameters<typeof CodexSessionRuntime> = [() => process];
    args[15] = f.scratch;
    const runtime = new CodexSessionRuntime(...args);
    await runtime.start(
      { ...f.session, threadId: null, state: 'starting' },
      '2026-01-01T00:00:00.000Z',
    );
    try {
      const result = await f.make(() => runtime.releaseForForget(f.session)).execute(f.session.id);
      expect(result).toMatchObject({ phase: 'failed', failureCode: 'SESSION_RELEASE_UNCONFIRMED' });
      expect(await readFile(join(f.context.directory, 'payload'), 'utf8')).toBe('scratch');
    } finally {
      runtime.stopAll();
      await runtime.drainReleases();
    }
  });

  it('waits for actual process exit and then actual deletion before removing the durable frame', async () => {
    const f = await fixture();
    const claim = await f.scratch.borrow(f.session);
    const child = spawn(
      process.execPath,
      [
        '-e',
        `process.on('message', m => { if(m==='exit') process.exit(0); }); process.send('ready'); setInterval(()=>{},1000);`,
      ],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...claim.environment },
      },
    );
    const exited = once(child, 'exit');
    const stopping = latch();
    const deleting = latch();
    const deleteRelease = latch();
    gates.remove = async (path) => {
      if (path.endsWith('/payload')) {
        deleting.release();
        await deleteRelease.wait;
      }
    };
    let ready = false;
    child.once('message', () => {
      ready = true;
    });
    const forget = f.make(async () => {
      stopping.release();
      await exited;
      expect(await stopOwnedProcessGroup(child, 0, 100)).toBe(true);
      await claim.release();
    });
    let running: ReturnType<typeof forget.execute> | undefined;
    try {
      await vi.waitFor(() => expect(ready).toBe(true), { timeout: 2000 });
      running = forget.execute(f.session.id);
      await barrier(stopping.wait, running);
      expect(child.exitCode).toBe(null);
      expect(f.operations.find(f.session.id)?.phase).toBe('stopping');
      expect(await readFile(join(f.context.directory, 'payload'), 'utf8')).toBe('scratch');
      child.send('exit');
      await barrier(deleting.wait, running);
      expect(child.exitCode).toBe(0);
      expect(f.operations.find(f.session.id)?.phase).toBe('cleaning');
      expect(f.sessions.find(f.session.id)).not.toBeNull();
      await expect(f.scratch.allocate(f.session)).rejects.toThrow('SESSION_FORGET_IN_PROGRESS');
      deleteRelease.release();
      expect((await running)?.phase).toBe('completed');
      expect(f.sessions.find(f.session.id)).toBeNull();
      expect(f.phases).toEqual(['stopping', 'cleaning', 'finalizing', 'completed']);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      deleteRelease.release();
      await running;
    }
  });

  it('joins duplicate requests and retains the same operation for a completed retry', async () => {
    const f = await fixture();
    const entered = latch();
    const proceed = latch();
    let releases = 0;
    const forget = f.make(async () => {
      releases++;
      entered.release();
      await proceed.wait;
    });
    const first = forget.execute(f.session.id);
    const second = forget.execute(f.session.id);
    try {
      await barrier(entered.wait, first);
      expect(second).toBe(first);
      expect(releases).toBe(1);
    } finally {
      proceed.release();
      await Promise.all([first, second]);
    }
    const result = await first;
    expect((await forget.execute(f.session.id))?.operationId).toBe(result?.operationId);
    expect(releases).toBe(1);
  });

  it('retains failed cleanup and its frame, then retries the same operation', async () => {
    const f = await fixture();
    const failed = await f
      .make(undefined, async () => {
        throw new Error('disk failure');
      })
      .execute(f.session.id);
    expect(failed).toMatchObject({ phase: 'failed', failureCode: 'SESSION_CLEANUP_FAILED' });
    expect(f.sessions.find(f.session.id)?.threadId).toBe('provider-history');
    expect(await readFile(join(f.context.directory, 'payload'), 'utf8')).toBe('scratch');
    expect(await f.make().execute(f.session.id)).toMatchObject({
      operationId: failed?.operationId,
      phase: 'completed',
    });
  });

  it('never starts deletion after an unconfirmed release', async () => {
    const f = await fixture();
    const clean = vi.fn();
    const failed = await f
      .make(async () => {
        throw new Error('unknown owned group');
      }, clean)
      .execute(f.session.id);
    expect(failed).toMatchObject({ phase: 'failed', failureCode: 'SESSION_RELEASE_UNCONFIRMED' });
    expect(clean).not.toHaveBeenCalled();
    expect(f.sessions.find(f.session.id)).not.toBeNull();
  });

  it('completes already-removed scratch without losing retry identity', async () => {
    const f = await fixture();
    await rm(f.context.directory, { recursive: true });
    const result = await f.make().execute(f.session.id);
    expect(result?.phase).toBe('completed');
    expect(await f.make().execute(f.session.id)).toEqual(result);
  });

  it.each<ForgetPhase>(['stopping', 'cleaning', 'finalizing', 'failed'])(
    're-enters safe release after restart at %s and finalizes idempotently',
    async (phase) => {
      const f = await fixture();
      const prior = f.operations.begin(f.session.id)!;
      f.operations.update({ ...prior, phase });
      const reopened = new DatabaseSync(f.databasePath);
      databases.push(reopened);
      const operations = new SqliteForgetOperationStore(reopened);
      const release = vi.fn(async () => {});
      expect(await f.make(release, undefined, operations).execute(f.session.id)).toMatchObject({
        operationId: prior.operationId,
        phase: 'completed',
      });
      expect(release).toHaveBeenCalledTimes(1);
      expect(f.sessions.list()).toEqual([]);
    },
  );

  it('retains unknown crash leases on restart until the actual owning fixture confirms release', async () => {
    const f = await fixture();
    const claim = await f.scratch.borrow(f.session);
    const prior = f.operations.begin(f.session.id)!;
    const reopened = new DatabaseSync(f.databasePath);
    databases.push(reopened);
    const operations = new SqliteForgetOperationStore(reopened);
    expect(await f.make(undefined, undefined, operations).execute(f.session.id)).toMatchObject({
      phase: 'failed',
      failureCode: 'SESSION_CLEANUP_FAILED',
    });
    expect(f.sessions.find(f.session.id)).not.toBeNull();
    await claim.release();
    expect(await f.make().execute(f.session.id)).toMatchObject({
      operationId: prior.operationId,
      phase: 'completed',
    });
  });

  it('fences late saves and allocations from another server and prevents completed-ID resurrection', async () => {
    const f = await fixture();
    f.operations.begin(f.session.id);
    const reopened = new DatabaseSync(f.databasePath);
    databases.push(reopened);
    const operations = new SqliteForgetOperationStore(reopened);
    const sessions = new SqliteSessionRepository(reopened);
    const scratch = new FilesystemSessionScratch((id) => operations.assertAvailable(id));
    sessions.save({ ...f.session, model: 'late-restore' });
    expect(sessions.find(f.session.id)?.model).toBeUndefined();
    await expect(scratch.allocate(f.session)).rejects.toThrow('SESSION_FORGET_IN_PROGRESS');
    await f.make().execute(f.session.id);
    sessions.save(f.session);
    expect(sessions.find(f.session.id)).toBeNull();
  });

  it('keeps one operation ID across server instances and keeps completion terminal', async () => {
    const f = await fixture();
    const first = f.operations.begin(f.session.id)!;
    const reopened = new DatabaseSync(f.databasePath);
    databases.push(reopened);
    const other = new SqliteForgetOperationStore(reopened);
    expect(other.begin(f.session.id)?.operationId).toBe(first.operationId);
    await f.make().execute(f.session.id);
    expect(other.update({ ...first, phase: 'failed' }).phase).toBe('completed');
  });

  it('preserves provider history and persistent data while promotion allocates fresh scratch', async () => {
    const f = await fixture();
    const persistent = join(f.workspacePath, '.gestalt', 'context-mode');
    await mkdir(persistent, { recursive: true });
    await writeFile(join(persistent, 'keep.db'), 'persistent');
    const history = {
      id: 'provider-history',
      cwd: f.workspacePath,
      profile: 'default',
      recencyAt: null,
    };
    await f.make().execute(f.session.id);
    const promoted = await promoteRecentThread(history, {
      createId: () => 'new-relay',
      now: () => new Date().toISOString(),
      list: () => f.sessions.list(),
      save: (session) => f.sessions.save(session),
      read: async () => ({ turns: ['provider history'] }),
    });
    const fresh = await f.scratch.allocate(promoted);
    expect(fresh.directory).not.toBe(f.context.directory);
    await expect(readFile(join(fresh.directory, 'payload'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(promoted.threadId).toBe('provider-history');
    expect(await readFile(join(persistent, 'keep.db'), 'utf8')).toBe('persistent');
  });
});
