/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CleanSessionScratch } from '../../features/sessions/clean-tmp/use-case.js';
import { RelaySession, type SessionState } from '../../features/sessions/model/relay-session.js';
import { FilesystemWorkspaceCatalog } from '../catalog/filesystem-workspace-catalog.js';
import { migrate } from '../persistence/migrate.js';
import { SqliteSessionRepository } from '../persistence/sqlite-session-repository.js';
import { FilesystemScratchCleanup } from './filesystem-scratch-cleanup.js';
import { FilesystemSessionScratch, scratchMarkerName } from './filesystem-session-scratch.js';
import { claimOwnerFence } from './owner-fence.js';
import { withScratchContainment } from './containment-fence.js';

const gates = vi.hoisted(() => ({
  read: undefined as undefined | ((path: string) => Promise<void>),
  remove: undefined as undefined | ((path: string) => Promise<void>),
  open: undefined as undefined | ((path: string) => Promise<void>),
  rename: undefined as undefined | ((from: string, to: string) => Promise<void>),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      await gates.open?.(String(args[0]));
      return actual.open(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await gates.rename?.(String(args[0]), String(args[1]));
      return actual.rename(...args);
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      await gates.read?.(String(args[0]));
      return actual.readdir(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await gates.remove?.(String(args[0]));
      return actual.rm(...args);
    },
  };
});

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  gates.read = undefined;
  gates.remove = undefined;
  gates.open = undefined;
  gates.rename = undefined;
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const base = join(process.cwd(), 'tmp', 'mobile-scratch-tests');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, 'cleanup-fixture-'));
  roots.push(root);
  const workspacePath = join(root, 'workspace with spaces');
  await mkdir(workspacePath);
  const databasePath = join(root, 'relay.sqlite');
  const db = new DatabaseSync(databasePath);
  databases.push(db);
  migrate(db);
  const sessions = new SqliteSessionRepository(db);
  const scratch = new FilesystemSessionScratch();
  const storage = new FilesystemScratchCleanup();
  const known = [workspacePath];
  const cleanup = () =>
    new CleanSessionScratch({
      knownWorkspacePaths: async () => [...known, ...sessions.knownWorkspacePaths()],
      sessions: () => sessions.list(),
      storage,
    }).execute();
  const session = (id = 'relay-1', state: SessionState = 'ready') => ({
    ...RelaySession.create({
      id,
      workspaceId: 'w',
      workspacePath,
      provider: 'codex',
      profile: 'default',
      effectiveSkillSelection: { skills: [] },
      sandbox: 'workspace-git',
      approvalPolicy: 'never',
      now: '2026-01-01T00:00:00.000Z',
    }).snapshot,
    state,
  });
  return {
    root,
    workspacePath,
    databasePath,
    db,
    sessions,
    scratch,
    storage,
    known,
    cleanup,
    session,
  };
}

async function leaseOwner(workspacePath: string, kind: 'cli' | 'service', state = 'released') {
  const ownerId = `${kind}-${randomUUID()}`;
  const directory = join(workspacePath, 'tmp', 'sessions', ownerId);
  const leaseId = randomUUID();
  await mkdir(join(directory, 'leases'), { recursive: true, mode: 0o700 });
  const marker = {
    schemaVersion: 1,
    ownerKind: kind === 'cli' ? 'cli-session' : 'workspace-service',
    ownerId,
    workspacePath,
    sessionId: ownerId,
    createdAt: '2026-01-01T00:00:00.000Z',
    authority: { kind: 'lease', leaseId },
    providerThreads: [{ provider: 'codex', threadId: 'explicit-root' }],
  };
  await writeFile(join(directory, scratchMarkerName), JSON.stringify(marker), { mode: 0o600 });
  const lease = {
    schemaVersion: 1,
    ownerId,
    workspacePath,
    leaseId,
    state,
    processIdentity: randomUUID(),
    createdAt: marker.createdAt,
    updatedAt: marker.createdAt,
    consumers: state === 'released' ? [] : ['manager'],
  };
  const leasePath = join(directory, 'leases', `${leaseId}.json`);
  await writeFile(leasePath, JSON.stringify(lease), { mode: 0o600 });
  return { directory, lease, leasePath, marker };
}

function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

async function enteredWhile(entered: Promise<unknown>, operation: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      operation.then(() => {
        throw new Error('Fixture operation ended before its barrier');
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Fixture barrier timed out')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function launcherAllocation(workspace: string, ready?: string, proceed?: string) {
  const runtime = await readFile(
    join(process.cwd(), 'test', 'fixtures', 'scratch', 'launcher-containment-runtime.cjs.txt'),
    'utf8',
  );
  expect(createHash('sha256').update(runtime).digest('hex')).toBe(
    '12a51c4306240366b3a316042d2b2deac6bdc0077020cfc611f36d346ad8fa94',
  );
  const driver = `
try {
  const selected = process.argv[1], ready = process.argv[2], proceed = process.argv[3];
  if (ready) {
    const publish = scratchPublish;
    scratchPublish = (file, value, initial) => {
      if (initial && file.endsWith('/.gestalt-owner.json')) {
        scratchFs.writeFileSync(ready, 'held');
        const end = Date.now() + 3000;
        while (!scratchFs.existsSync(proceed)) {
          if (Date.now() > end) throw Error('FIXTURE_BARRIER_TIMEOUT');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return publish(file, value, initial);
    };
  }
  const owner = scratchAllocate(selected, 'cli-session', 'fixture-publication');
  if (!scratchRelease(owner)) throw Error('FIXTURE_RELEASE_UNCONFIRMED');
  console.log(JSON.stringify({ published: true, directory: owner.context.directory }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message })); process.exitCode = 2;
}`;
  const child = spawn(
    process.execPath,
    ['-e', runtime + driver, workspace, ready ?? '', proceed ?? ''],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk).slice(0, Math.max(0, 8192 - output.length));
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk).slice(0, Math.max(0, 8192 - output.length));
  });
  const completed = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
  void completed.catch(() => undefined);
  return { child, completed };
}

describe('managed scratch cleanup', () => {
  it('blocks actual Launcher allocation while Mobile holds the containing owner before retirement', async () => {
    const f = await fixture();
    const outer = await f.scratch.allocate(f.session('outer-orphan'));
    const workspace = join(outer.directory, 'selected-workspace');
    await mkdir(workspace);
    const entered = latch();
    const proceed = latch();
    gates.rename = async (from) => {
      if (from === outer.directory) {
        entered.release();
        await proceed.wait;
      }
    };
    const cleaning = f.cleanup();
    let launcher: Awaited<ReturnType<typeof launcherAllocation>> | undefined;
    try {
      await enteredWhile(entered.wait, cleaning);
      await expect(
        f.scratch.allocate({ id: 'late-mobile', workspacePath: workspace }),
      ).rejects.toThrow('SESSION_SCRATCH_CONTAINMENT_BUSY');
      const publish = vi.fn();
      await expect(withScratchContainment(workspace, publish)).rejects.toThrow(
        'SESSION_SCRATCH_CONTAINMENT_BUSY',
      );
      expect(publish).not.toHaveBeenCalled();
      launcher = await launcherAllocation(workspace);
      const result = await launcher.completed;
      expect(result.code, result.output).toBe(2);
      expect(JSON.parse(result.output).error).toBe('SESSION_SCRATCH_CONTAINMENT_BUSY');
      await expect(lstat(join(workspace, 'tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
      proceed.release();
      expect((await cleaning).folders).toMatchObject({ removed: 1, failed: 0 });
      await expect(
        f.scratch.allocate({ id: 'late-mobile', workspacePath: workspace }),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(outer.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      proceed.release();
      if (launcher?.child.exitCode === null && launcher.child.signalCode === null)
        launcher.child.kill('SIGTERM');
      await Promise.allSettled([cleaning, launcher?.completed]);
    }
  });

  it('retains an outer owner while actual Launcher publication holds its ancestor fence', async () => {
    const f = await fixture();
    const outer = await f.scratch.allocate(f.session('outer-orphan'));
    const workspace = join(outer.directory, 'selected-workspace');
    await mkdir(workspace);
    const ready = join(f.root, 'launcher-ready');
    const proceed = join(f.root, 'launcher-proceed');
    const launcher = await launcherAllocation(workspace, ready, proceed);
    try {
      await enteredWhile(
        vi.waitFor(async () => expect(await readFile(ready, 'utf8')).toBe('held')),
        launcher.completed,
      );
      expect((await f.cleanup()).folders).toMatchObject({
        removed: 0,
        skipped: 1,
        failed: 0,
        reasons: { busy: 1 },
      });
      expect(await lstat(workspace).then((info) => info.isDirectory())).toBe(true);
      await writeFile(proceed, 'continue');
      const result = await launcher.completed;
      expect(result.code, result.output).toBe(0);
      const published = JSON.parse(result.output) as { directory: string };
      expect(await readFile(join(published.directory, scratchMarkerName), 'utf8')).toContain(
        'cli-session',
      );
      expect((await f.cleanup()).folders).toMatchObject({
        removed: 0,
        skipped: 1,
        reasons: { unrecognized: 1 },
      });
    } finally {
      await writeFile(proceed, 'continue');
      if (launcher.child.exitCode === null && launcher.child.signalCode === null)
        launcher.child.kill('SIGTERM');
      await Promise.allSettled([launcher.completed]);
    }
  });

  it.each(['released', 'turnActive'] as const)(
    'retains an orphan outer owner containing a durable %s inner workspace and cleans an unrelated owner',
    async (state) => {
      const f = await fixture();
      const outer = await f.scratch.allocate(f.session('outer-orphan'));
      const workspacePath = join(outer.directory, 'selected-workspace');
      await mkdir(workspacePath);
      const inner = { ...f.session('inner', state), workspacePath };
      f.sessions.save(inner);
      const owned = await f.scratch.allocate(inner);
      const payload = join(owned.directory, 'retained');
      await writeFile(payload, 'inner');
      const lease = state === 'turnActive' ? await f.scratch.borrow(inner) : undefined;
      await f.scratch.allocate(f.session('unrelated'));
      try {
        const result = await f.cleanup();
        expect(result).toMatchObject({
          status: 'complete',
          folders: { removed: 1, skipped: 2, failed: 0 },
        });
        expect(result.folders.reasons.protected).toBeGreaterThanOrEqual(1);
        expect(await readFile(payload, 'utf8')).toBe('inner');
        expect(f.sessions.find(inner.id)).not.toBeNull();
        expect(await readFile(join(outer.directory, scratchMarkerName), 'utf8')).toContain(
          'outer-orphan',
        );
      } finally {
        await lease?.release();
      }
    },
  );

  it('protects a durable inner workspace even before it has allocated scratch', async () => {
    const f = await fixture();
    const outer = await f.scratch.allocate(f.session('outer-orphan'));
    const workspacePath = join(outer.directory, 'selected-workspace');
    await mkdir(workspacePath);
    f.sessions.save({
      ...f.session('saved-without-runtime', 'released'),
      workspacePath: `${workspacePath}/.`,
    });
    await writeFile(join(workspacePath, 'source'), 'preserve');
    const result = await f.cleanup();
    expect(result.folders).toMatchObject({ removed: 0, skipped: 1, reasons: { protected: 1 } });
    expect(await readFile(join(workspacePath, 'source'), 'utf8')).toBe('preserve');
  });

  it.each([
    ['cli', 'active'],
    ['service', 'active'],
    ['cli', 'unknown-borrower'],
    ['service', 'unknown-borrower'],
    ['cli', 'detached-borrower'],
  ] as const)('retains an outer owner around nested %s %s metadata', async (kind, state) => {
    const f = await fixture();
    const outer = await f.scratch.allocate(f.session('outer-orphan'));
    const workspacePath = join(outer.directory, 'nested-workspace');
    await mkdir(workspacePath);
    const nested = await leaseOwner(
      workspacePath,
      kind,
      state === 'active' ? 'active' : 'released',
    );
    if (state !== 'active') {
      const leaseId = randomUUID();
      await writeFile(
        join(nested.directory, 'leases', `${leaseId}.json`),
        JSON.stringify({
          ...nested.lease,
          leaseId,
          processIdentity: randomUUID(),
          state: state === 'detached-borrower' ? 'active' : 'unknown',
          consumers: ['detached-child'],
        }),
        { mode: 0o600 },
      );
    }
    await writeFile(join(nested.directory, 'payload'), 'protected');
    f.known.push(workspacePath);
    await f.scratch.allocate(f.session('unrelated'));
    const result = await f.cleanup();
    expect(result.folders).toMatchObject({ removed: 1, skipped: 2, failed: 0 });
    expect(result.folders.reasons.lease).toBe(1);
    expect(await readFile(join(nested.directory, 'payload'), 'utf8')).toBe('protected');
  });

  it('retains an outer owner around an unmarked partial nested namespace', async () => {
    const f = await fixture();
    const outer = await f.scratch.allocate(f.session('outer-orphan'));
    const unknown = join(outer.directory, 'workspace', 'tmp', 'sessions', 'unrecognized-owner');
    await mkdir(unknown, { recursive: true, mode: 0o700 });
    await writeFile(join(unknown, 'payload'), 'unknown');
    await f.scratch.allocate(f.session('unrelated'));
    expect((await f.cleanup()).folders).toMatchObject({
      removed: 1,
      skipped: 1,
      reasons: { unrecognized: 1 },
    });
    expect(await readFile(join(unknown, 'payload'), 'utf8')).toBe('unknown');
  });

  it('retains an empty nested namespace and persistent workspace data without guessing ownership', async () => {
    const f = await fixture();
    const outer = await f.scratch.allocate(f.session('outer-orphan'));
    const workspace = join(outer.directory, 'workspace');
    await mkdir(join(workspace, 'tmp', 'sessions'), { recursive: true, mode: 0o700 });
    await writeFile(join(workspace, 'tmp', 'sessions', '.gitignore'), '*\n');
    const persistent = join(workspace, '.gestalt', 'context-mode');
    await mkdir(persistent, { recursive: true });
    await writeFile(join(persistent, 'keep.db'), 'persistent');
    expect((await f.cleanup()).folders).toMatchObject({
      removed: 0,
      skipped: 1,
      reasons: { unrecognized: 1 },
    });
    expect(await readFile(join(persistent, 'keep.db'), 'utf8')).toBe('persistent');
  });

  it('protects a retired owner by its logical contained workspace and never recreates the retired selection', async () => {
    const f = await fixture();
    const outer = await f.scratch.allocate(f.session('outer-orphan'));
    const workspacePath = join(outer.directory, 'selected-workspace');
    await mkdir(workspacePath);
    const inner = { ...f.session('inner', 'released'), workspacePath };
    f.sessions.save(inner);
    await writeFile(join(workspacePath, 'payload'), 'keep');
    const retired = join(
      f.workspacePath,
      'tmp',
      'sessions',
      `.cleanup-${outer.ownerId}-${randomUUID()}`,
    );
    await rename(outer.directory, retired);
    const result = await f.cleanup();
    expect(result.folders).toMatchObject({ removed: 0, skipped: 1, reasons: { protected: 1 } });
    expect(await readFile(join(retired, 'selected-workspace', 'payload'), 'utf8')).toBe('keep');
    await expect(f.scratch.allocate(inner)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(outer.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each<SessionState>([
    'starting',
    'ready',
    'turnActive',
    'recovering',
    'attentionRequired',
    'stopped',
    'released',
  ])(
    'protects durable %s sessions even with old timestamps and no runtime/browser',
    async (state) => {
      const f = await fixture();
      f.sessions.save(f.session('saved-reopenable', state));
      const context = await f.scratch.allocate(f.session('saved-reopenable', state));
      const result = await f.cleanup();
      expect(result.folders).toMatchObject({
        removed: 0,
        skipped: 1,
        failed: 0,
        reasons: { protected: 1 },
      });
      expect(await lstat(context.directory)).toBeDefined();
    },
  );

  it('protects a saved roster loaded by another server before lazy restore', async () => {
    const f = await fixture();
    const session = f.session();
    f.sessions.save(session);
    await f.scratch.allocate(session);
    const reopened = new DatabaseSync(f.databasePath);
    databases.push(reopened);
    const roster = new SqliteSessionRepository(reopened);
    const result = await new CleanSessionScratch({
      sessions: () => roster.list(),
      knownWorkspacePaths: async () => roster.knownWorkspacePaths(),
      storage: f.storage,
    }).execute();
    expect(result.folders.reasons.protected).toBe(1);
  });

  it('removes missing and explicitly forgotten owners while preserving forgotten workspace locators', async () => {
    const f = await fixture();
    const session = f.session();
    f.sessions.save(session);
    const forgotten = await f.scratch.allocate(session);
    const missing = await f.scratch.allocate(f.session('missing'));
    f.sessions.remove(session.id);
    f.known.splice(0);
    expect(f.sessions.knownWorkspacePaths()).toEqual([f.workspacePath]);
    expect((await f.cleanup()).folders).toMatchObject({ removed: 2, skipped: 0, failed: 0 });
    await expect(lstat(forgotten.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(missing.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await f.cleanup()).folders.removed).toBe(0);
  });

  it('deduplicates canonical paths and handles two known workspaces and nested selections', async () => {
    const f = await fixture();
    const second = join(f.root, 'second');
    const nested = join(f.workspacePath, 'repository');
    await mkdir(second);
    await mkdir(nested);
    await f.scratch.allocate(f.session());
    await f.scratch.allocate({ id: 'second', workspacePath: second });
    await f.scratch.allocate({ id: 'nested', workspacePath: nested });
    f.known.push(`${f.workspacePath}/.`, second, nested);
    const result = await f.cleanup();
    expect(result.workspaces.cleaned).toBe(3);
    expect(result.folders.removed).toBe(3);
  });

  it('uses catalog provenance and retains selections across migration and removal', async () => {
    const f = await fixture();
    const nested = join(f.workspacePath, 'nested');
    await mkdir(nested);
    await mkdir(join(nested, '.git'));
    const catalog = new FilesystemWorkspaceCatalog(f.workspacePath);
    expect(await catalog.knownWorkspacePaths()).toEqual([f.workspacePath, nested]);
    f.sessions.save(f.session());
    migrate(f.db);
    f.sessions.remove('relay-1');
    expect(f.sessions.knownWorkspacePaths()).toEqual([f.workspacePath]);
  });

  it.each(['cli', 'service'] as const)(
    'keeps active, crashed and partially published %s leases, deletes confirmed release',
    async (kind) => {
      const f = await fixture();
      await f.scratch.allocate(f.session('orphan'));
      await leaseOwner(f.workspacePath, kind, 'active');
      await leaseOwner(f.workspacePath, kind, 'unknown');
      const partial = await leaseOwner(f.workspacePath, kind);
      await rm(partial.leasePath);
      await leaseOwner(f.workspacePath, kind);
      const result = await f.cleanup();
      expect(result.folders).toMatchObject({
        removed: 2,
        skipped: 3,
        failed: 0,
        reasons: { lease: 3 },
      });
    },
  );

  it('checks every borrower and retains partial metadata instead of using PID or age', async () => {
    const f = await fixture();
    await f.scratch.allocate(f.session('orphan'));
    const owner = await leaseOwner(f.workspacePath, 'cli');
    const borrower = randomUUID();
    await writeFile(
      join(owner.directory, 'leases', `${borrower}.json`),
      JSON.stringify({
        ...owner.lease,
        leaseId: borrower,
        state: 'active',
        consumers: ['child'],
      }),
      { mode: 0o600 },
    );
    expect((await f.cleanup()).folders.reasons.lease).toBe(1);
    await rm(join(owner.directory, 'leases', `${borrower}.json`));
    await writeFile(join(owner.directory, 'leases', '.unpublished.json'), '{}', { mode: 0o600 });
    expect((await f.cleanup()).folders.reasons.lease).toBe(1);
    expect(await readFile(owner.leasePath, 'utf8')).toContain('released');
  });

  it('holds Mobile service fences through actual manager release and protects borrowers', async () => {
    const f = await fixture();
    const service = await f.scratch.allocateService(f.workspacePath, 'manager');
    const borrower = randomUUID();
    const path = join(service.directory, 'leases', `${borrower}.json`);
    try {
      expect((await f.cleanup()).folders.reasons.busy).toBe(1);
      await writeFile(path, '{}', { mode: 0o600 });
      await expect(service.release()).rejects.toThrow('SESSION_SCRATCH_BORROWERS_ACTIVE');
    } finally {
      await rm(path, { force: true });
      await service.release();
    }
    expect((await f.cleanup()).folders.removed).toBe(1);
  });

  it('honors a controller fence held by another OS process until its explicit release', async () => {
    const f = await fixture();
    const context = await f.scratch.allocate(f.session());
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      const fs = require('node:fs');
      const lock = process.argv[1];
      fs.mkdirSync(lock, {mode: 0o700});
      process.stdout.write('held');
      process.stdin.resume();
      process.stdin.on('end', () => fs.rmdirSync(lock));
    `,
        join(context.directory, '.controller-lock'),
      ],
      {
        env: { PATH: process.env.PATH, ...context.environment },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const exited = once(child, 'exit');
    try {
      await enteredWhile(once(child.stdout, 'data'), exited);
      expect((await f.cleanup()).folders.reasons.busy).toBe(1);
    } finally {
      child.stdin.end();
      await exited;
    }
    expect((await f.cleanup()).folders.removed).toBe(1);
  });

  it.each(['{', 'null', '{"schemaVersion":99}'])(
    'retains malformed or unknown markers %s',
    async (contents) => {
      const f = await fixture();
      const context = await f.scratch.allocate(f.session());
      await writeFile(join(context.directory, scratchMarkerName), contents);
      expect((await f.cleanup()).folders).toMatchObject({
        removed: 0,
        skipped: 1,
        reasons: { unrecognized: 1 },
      });
      expect(await readFile(join(context.directory, scratchMarkerName), 'utf8')).toBe(contents);
    },
  );

  it('retains foreign marker provenance and ambiguous legacy/persistent siblings', async () => {
    const f = await fixture();
    const context = await f.scratch.allocate(f.session());
    const markerPath = join(context.directory, scratchMarkerName);
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    await writeFile(markerPath, JSON.stringify({ ...marker, workspacePath: f.root }));
    const legacy = join(f.workspacePath, 'tmp', 'gestalt-cli-playwright-old');
    await mkdir(legacy);
    await writeFile(join(legacy, 'keep'), 'ambiguous');
    await mkdir(join(f.workspacePath, '.gestalt', 'context-mode'), { recursive: true });
    await writeFile(join(f.workspacePath, '.gestalt', 'context-mode', 'keep.db'), 'persistent');
    expect((await f.cleanup()).folders.reasons.unrecognized).toBe(2);
    expect(await readFile(join(legacy, 'keep'), 'utf8')).toBe('ambiguous');
    expect(
      await readFile(join(f.workspacePath, '.gestalt', 'context-mode', 'keep.db'), 'utf8'),
    ).toBe('persistent');
  });

  it('retains unmarked collisions, unknown namespaces and in-progress association fences', async () => {
    const f = await fixture();
    const context = await f.scratch.allocate(f.session());
    await mkdir(join(context.directory, '.association-lock'), { mode: 0o700 });
    const unmarked = join(f.workspacePath, 'tmp', 'sessions', `cli-${randomUUID()}`);
    await mkdir(unmarked, { mode: 0o700 });
    await mkdir(join(f.workspacePath, 'tmp', 'sessions', 'other-owner'), { mode: 0o700 });
    const result = await f.cleanup();
    expect(result.folders).toMatchObject({ removed: 0, skipped: 3, failed: 0 });
    expect(result.folders.reasons.busy).toBe(1);
    expect(result.folders.reasons.unrecognized).toBe(2);
  });

  it.each(['marker', 'lease'] as const)('retains symlinked %s metadata', async (kind) => {
    const f = await fixture();
    await f.scratch.allocate(f.session('orphan'));
    const owner = await leaseOwner(f.workspacePath, 'cli');
    const path = kind === 'marker' ? join(owner.directory, scratchMarkerName) : owner.leasePath;
    const target = join(f.root, 'metadata');
    const contents = await readFile(path, 'utf8');
    await writeFile(target, contents, { mode: 0o600 });
    await rm(path);
    await symlink(target, path);
    const result = await f.cleanup();
    expect(result.folders).toMatchObject({ removed: 1, skipped: 1, failed: 0 });
    expect(await readFile(target, 'utf8')).toBe(contents);
  });

  it('cleans payload directory symlinks without deleting their external targets', async () => {
    const f = await fixture();
    const context = await f.scratch.allocate(f.session());
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'keep'), 'keep');
    await symlink(outside, join(context.directory, 'link'));
    expect((await f.cleanup()).folders).toMatchObject({ removed: 1, skipped: 0, failed: 0 });
    await expect(lstat(context.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('keep');
  });

  it.each(['workspace', 'tmp', 'container', 'owner'])(
    'retains symlinked %s paths without deleting their targets',
    async (part) => {
      const f = await fixture();
      const context = await f.scratch.allocate(f.session());
      const outside = join(f.root, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'keep'), 'keep');
      if (part === 'workspace') {
        const alias = join(f.root, 'alias');
        await symlink(f.workspacePath, alias);
        f.known.splice(0, f.known.length, alias);
      } else {
        const target =
          part === 'tmp'
            ? join(f.workspacePath, 'tmp')
            : part === 'container'
              ? join(f.workspacePath, 'tmp', 'sessions')
              : context.directory;
        await rm(target, { recursive: true });
        await symlink(outside, target);
      }
      const result = await f.cleanup();
      expect(result.folders.removed).toBe(0);
      expect(result.folders.reasons.unsafe).toBeGreaterThan(0);
      expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('keep');
    },
  );

  it('reports inaccessible workspaces while completing available workspaces', async () => {
    const f = await fixture();
    await f.scratch.allocate(f.session());
    const denied = join(f.root, 'denied');
    await mkdir(denied);
    await chmod(denied, 0);
    f.known.push(join(denied, 'workspace'));
    try {
      const result = await f.cleanup();
      expect(result.status).toBe('partial');
      expect(result.workspaces.unavailable).toBe(1);
      expect(result.folders.removed).toBe(1);
    } finally {
      await chmod(denied, 0o700);
    }
  });

  it('rechecks another server roster under the fence and prevents allocation during cleanup', async () => {
    const f = await fixture();
    const session = f.session();
    const context = await f.scratch.allocate(session);
    const entered = latch();
    const proceed = latch();
    let held = false;
    gates.read = async (path) => {
      const fenced =
        path === context.directory &&
        (await lstat(join(path, '.controller-lock')).then(
          () => true,
          () => false,
        ));
      if (!held && fenced) {
        held = true;
        entered.release();
        await proceed.wait;
      }
    };
    const cleaning = f.cleanup();
    try {
      await enteredWhile(entered.wait, cleaning);
      await expect(new FilesystemSessionScratch().allocate(session)).rejects.toThrow(
        'SESSION_SCRATCH_BUSY',
      );
      const other = new DatabaseSync(f.databasePath);
      databases.push(other);
      new SqliteSessionRepository(other).save(session);
    } finally {
      proceed.release();
      await cleaning;
    }
    expect((await cleaning).folders.reasons.protected).toBe(1);
    expect(await f.scratch.allocate(session)).toEqual(context);
  });

  it('protects a held allocation fence and settles concurrent cleanup calls', async () => {
    const f = await fixture();
    const context = await f.scratch.allocate(f.session());
    const release = await claimOwnerFence(context.directory);
    try {
      expect((await f.cleanup()).folders.reasons.busy).toBe(1);
    } finally {
      await release();
    }
    const results = await Promise.all([f.cleanup(), f.cleanup()]);
    expect(results.reduce((sum, result) => sum + result.folders.removed, 0)).toBe(1);
    expect(results.every((result) => result.folders.failed === 0)).toBe(true);
  });

  it('retries failed removal from its isolated namespace without touching a new allocation', async () => {
    const f = await fixture();
    const session = f.session();
    const context = await f.scratch.allocate(session);
    await writeFile(join(context.directory, 'payload'), 'old');
    gates.remove = async (path) => {
      if (path.endsWith('/payload'))
        throw Object.assign(new Error('fixture failure'), { code: 'EACCES' });
    };
    expect((await f.cleanup()).folders.failed).toBe(1);
    gates.remove = undefined;
    const names = await readdir(join(f.workspacePath, 'tmp', 'sessions'));
    expect(names.some((name) => name.startsWith('.cleanup-'))).toBe(true);
    const fresh = await f.scratch.allocate(session);
    await writeFile(join(fresh.directory, 'new'), 'new');
    f.sessions.save(session);
    expect((await f.cleanup()).folders.removed).toBe(0);
    expect(await readFile(join(fresh.directory, 'new'), 'utf8')).toBe('new');
    f.sessions.remove(session.id);
    expect((await f.cleanup()).folders.removed).toBe(2);
  });

  it('keeps new allocation separate while old payload removal is held', async () => {
    const f = await fixture();
    const session = f.session();
    const context = await f.scratch.allocate(session);
    await writeFile(join(context.directory, 'payload'), 'old');
    const entered = latch();
    const proceed = latch();
    gates.remove = async (path) => {
      if (path.endsWith('/payload')) {
        entered.release();
        await proceed.wait;
      }
    };
    const cleaning = f.cleanup();
    try {
      await enteredWhile(entered.wait, cleaning);
      const fresh = await f.scratch.allocate(session);
      await writeFile(join(fresh.directory, 'new'), 'new');
      f.sessions.save(session);
    } finally {
      proceed.release();
      await cleaning;
    }
    expect((await cleaning).folders.removed).toBe(1);
    expect(await readFile(join(context.directory, 'new'), 'utf8')).toBe('new');
    expect((await f.cleanup()).folders.reasons.protected).toBe(1);
  });

  it('does not interfere with another cleanup while its removal destination is being reserved', async () => {
    const f = await fixture();
    const context = await f.scratch.allocate(f.session());
    const reserved = latch();
    const proceed = latch();
    const unknownHeld = latch();
    const releaseUnknown = latch();
    let destination = '';
    let reservationPending = false;
    gates.rename = async (from, to) => {
      if (from === context.directory) {
        destination = to;
        reservationPending = true;
        reserved.release();
        await proceed.wait;
        reservationPending = false;
      }
    };
    gates.open = async (path) => {
      // Capture the phase before awaiting: post-rename owner revalidation is valid.
      const inspectingReservation =
        reservationPending && path === join(destination, scratchMarkerName);
      if (inspectingReservation) {
        // Older cleanup claimed this empty reservation before discovering its
        // marker was absent, making the first cleaner's rename fail ENOTEMPTY.
        const held = await lstat(join(destination, '.controller-lock'))
          .then(() => true)
          .catch(() => false);
        if (held) {
          unknownHeld.release();
          await releaseUnknown.wait;
        }
      }
    };
    const first = f.cleanup();
    let second: Promise<unknown> | undefined;
    try {
      await enteredWhile(reserved.wait, first);
      second = f.cleanup();
      await enteredWhile(Promise.race([second, unknownHeld.wait]), first);
      proceed.release();
      expect((await first).folders).toMatchObject({ removed: 1, failed: 0 });
    } finally {
      proceed.release();
      releaseUnknown.release();
      await Promise.allSettled([first, second]);
    }
  });
});
