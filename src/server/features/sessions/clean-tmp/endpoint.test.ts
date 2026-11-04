/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCleanTmp, type TmpCleanupPort } from './endpoint.js';
import { CleanSessionScratch, emptyScratchCounts } from './use-case.js';
import { RelaySession, type SessionState } from '../model/relay-session.js';
import { registerAuthorizationBoundary } from '../../../platform/http/authorization-boundary.js';
import {
  FilesystemSessionScratch,
  mobileScratchOwnerId,
  scratchMarkerName,
} from '../../../platform/scratch/filesystem-session-scratch.js';
import { FilesystemScratchCleanup } from '../../../platform/scratch/filesystem-scratch-cleanup.js';
import { SqliteSessionRepository } from '../../../platform/persistence/sqlite-session-repository.js';
import { migrate } from '../../../platform/persistence/migrate.js';
import { buildApp } from '../../../app.js';
import { FilesystemWorkspaceCatalog } from '../../../platform/catalog/filesystem-workspace-catalog.js';

const origin = 'https://gestalt.example:8443';
const headers = { origin, cookie: 'gestalt_mobile_session=live' };
const roots: string[] = [];
const databases: DatabaseSync[] = [];
const execute = promisify(execFile);
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function snapshot() {
  return {
    status: 'complete' as const,
    folders: emptyScratchCounts(),
    workspaces: { cleaned: 0, removed: 0, skipped: 0, failed: 0, unavailable: 0 },
  };
}

async function app(cleanup?: TmpCleanupPort) {
  const instance = fastify();
  registerAuthorizationBoundary(instance, {
    repository: { sessionDevice: (token: string) => (token === 'live' ? 'device' : null) } as never,
    clock: { now: () => new Date() },
    publicOrigin: origin,
  });
  registerCleanTmp(instance, cleanup);
  return instance;
}

async function fixture() {
  const base = join(process.cwd(), 'tmp', 'mobile-scratch-tests');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, 'clean-api-'));
  roots.push(root);
  const workspacePath = join(root, 'workspace with spaces');
  await mkdir(workspacePath);
  const db = new DatabaseSync(join(root, 'relay.sqlite'));
  databases.push(db);
  migrate(db);
  const sessions = new SqliteSessionRepository(db);
  const paths = [workspacePath];
  let catalogUnavailable = false;
  const cleanup = new CleanSessionScratch({
    sessions: () => sessions.list(),
    knownWorkspacePaths: async () => [...paths, ...sessions.knownWorkspacePaths()],
    additionalWorkspacePaths: async () => {
      if (catalogUnavailable) throw new Error('private catalog failure');
      return [];
    },
    storage: new FilesystemScratchCleanup(),
  });
  const scratch = new FilesystemSessionScratch();
  const session = (id: string, path = workspacePath, state: SessionState = 'ready') => ({
    ...RelaySession.create({
      id,
      workspaceId: 'w',
      workspacePath: path,
      provider: 'codex',
      profile: 'default',
      effectiveSkillSelection: { skills: [] },
      now: '2026-01-01T00:00:00.000Z',
    }).snapshot,
    state,
    desiredState:
      state === 'released' || state === 'stopped' ? ('stopped' as const) : ('active' as const),
    threadId: `provider-${id}`,
  });
  return {
    root,
    workspacePath,
    paths,
    sessions,
    scratch,
    session,
    cleanup,
    failCatalog: () => {
      catalogUnavailable = true;
    },
  };
}

async function cliOwner(workspacePath: string, borrower = false) {
  const ownerId = `cli-${randomUUID()}`;
  const leaseId = randomUUID();
  const directory = join(workspacePath, 'tmp', 'sessions', ownerId);
  await mkdir(join(directory, 'leases'), { recursive: true, mode: 0o700 });
  const createdAt = '2026-01-01T00:00:00.000Z';
  await writeFile(
    join(directory, '.gestalt-owner.json'),
    JSON.stringify({
      schemaVersion: 1,
      ownerKind: 'cli-session',
      ownerId,
      workspacePath,
      sessionId: ownerId,
      createdAt,
      authority: { kind: 'lease', leaseId },
      providerThreads: [],
    }),
    { mode: 0o600 },
  );
  const record = {
    schemaVersion: 1,
    ownerId,
    workspacePath,
    leaseId,
    state: borrower ? 'released' : 'active',
    processIdentity: randomUUID(),
    createdAt,
    updatedAt: createdAt,
    consumers: borrower ? [] : ['cli-fixture'],
  };
  await writeFile(join(directory, 'leases', `${leaseId}.json`), JSON.stringify(record), {
    mode: 0o600,
  });
  if (borrower) {
    const childLease = randomUUID();
    await writeFile(
      join(directory, 'leases', `${childLease}.json`),
      JSON.stringify({
        ...record,
        leaseId: childLease,
        processIdentity: randomUUID(),
        state: 'active',
        consumers: ['detached-child'],
      }),
      { mode: 0o600 },
    );
  }
  return directory;
}

describe('POST /api/maintenance/clean-tmp', () => {
  it.each([
    [{ origin }, 401, 'AUTH_REQUIRED'],
    [{ cookie: headers.cookie }, 403, 'ORIGIN_NOT_ALLOWED'],
    [{ ...headers, origin: 'https://foreign.example' }, 403, 'ORIGIN_NOT_ALLOWED'],
    [{ ...headers, cookie: 'gestalt_mobile_session=expired' }, 401, 'AUTH_REQUIRED'],
  ] as const)(
    'enforces authorization and exact origin before cleanup (%s)',
    async (requestHeaders, status, code) => {
      const execute = vi.fn(async () => snapshot());
      const instance = await app({ execute });
      try {
        const reply = await instance.inject({
          method: 'POST',
          url: '/api/maintenance/clean-tmp',
          headers: requestHeaders,
          payload: {},
        });
        expect(reply.statusCode).toBe(status);
        expect(reply.json().code).toBe(code);
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await instance.close();
      }
    },
  );

  it.each([
    { payload: { path: '/tmp' } },
    { payload: { workspacePath: '/' } },
    { payload: { force: true } },
    { payload: [] },
    { payload: null },
  ])('rejects body options instead of accepting a path (%j)', async ({ payload }) => {
    const execute = vi.fn(async () => snapshot());
    const instance = await app({ execute });
    try {
      const reply = await instance.inject({
        method: 'POST',
        url: '/api/maintenance/clean-tmp',
        headers: { ...headers, 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
      expect(reply.statusCode).toBe(400);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await instance.close();
    }
  });

  it('rejects query-path options without invoking the adapter', async () => {
    const execute = vi.fn(async () => snapshot());
    const instance = await app({ execute });
    try {
      expect(
        (
          await instance.inject({
            method: 'POST',
            url: '/api/maintenance/clean-tmp?path=/tmp',
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(400);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await instance.close();
    }
  });

  it('registers the cleanup slice through the normal application', async () => {
    const execute = vi.fn(async () => snapshot());
    const instance = await buildApp({
      health: { read: async () => ({ status: 'ok' }) } as never,
      logger: console,
      passkeyAuthDisabled: true,
      tmpCleanup: { execute },
    });
    try {
      expect(
        (await instance.inject({ method: 'POST', url: '/api/maintenance/clean-tmp', payload: {} }))
          .statusCode,
      ).toBe(200);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await instance.close();
    }
  });

  it('reports empty/idempotent cleanup without requiring an option or confirmation', async () => {
    const f = await fixture();
    const instance = await app(f.cleanup);
    try {
      const first = await instance.inject({
        method: 'POST',
        url: '/api/maintenance/clean-tmp',
        headers,
        payload: {},
      });
      const second = await instance.inject({
        method: 'POST',
        url: '/api/maintenance/clean-tmp',
        headers,
        payload: {},
      });
      expect(first.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(first.json()).toMatchObject({
        status: 'complete',
        folders: { removed: 0, skipped: 0, failed: 0 },
        workspaces: { cleaned: 1, removed: 0 },
      });
      expect(first.headers['cache-control']).toBe('no-store');
    } finally {
      await instance.close();
    }
  });

  it('cleans persisted workspaces after forgetting, deduplicates canonical aliases and protects all roster states', async () => {
    const f = await fixture();
    const second = join(f.root, 'second');
    await mkdir(second);
    f.paths.push(`${f.workspacePath}/.`, second, `${second}/.`);
    const ready = f.session('ready');
    const saved = f.session('saved', second, 'released');
    f.sessions.save(ready);
    f.sessions.save(saved);
    const readyContext = await f.scratch.allocate(ready);
    const savedContext = await f.scratch.allocate(saved);
    const forgotten = f.session('forgotten', second);
    f.sessions.save(forgotten);
    await f.scratch.allocate(forgotten);
    f.sessions.remove(forgotten.id);
    await f.scratch.allocate(f.session('missing'));
    const instance = await app(f.cleanup);
    try {
      const result = (
        await instance.inject({
          method: 'POST',
          url: '/api/maintenance/clean-tmp',
          headers,
          payload: {},
        })
      ).json();
      expect(result).toMatchObject({
        status: 'complete',
        folders: { removed: 2, skipped: 2, failed: 0 },
        workspaces: { removed: 2, skipped: 2, failed: 0, unavailable: 0 },
        reasons: { protected: 2 },
      });
      expect(f.sessions.list()).toHaveLength(2);
      expect(await readFile(join(readyContext.directory, '.gestalt-owner.json'), 'utf8')).toContain(
        'ready',
      );
      expect(await readFile(join(savedContext.directory, '.gestalt-owner.json'), 'utf8')).toContain(
        'saved',
      );
      expect(
        (
          await instance.inject({
            method: 'POST',
            url: '/api/maintenance/clean-tmp',
            headers,
            payload: {},
          })
        ).json().folders.removed,
      ).toBe(0);
    } finally {
      await instance.close();
    }
  });

  it('uses real catalog discovery without reporting a deleted owner as an unavailable workspace', async () => {
    const f = await fixture();
    const saved = f.session('catalog-saved', f.workspacePath, 'released');
    const live = f.session('catalog-live');
    f.sessions.save(saved);
    f.sessions.save(live);
    const savedOwner = await f.scratch.allocate(saved);
    const liveOwner = await f.scratch.allocate(live);
    const orphan = await f.scratch.allocate(f.session('catalog-orphan'));
    await writeFile(join(savedOwner.directory, 'payload'), 'saved');
    await writeFile(join(liveOwner.directory, 'payload'), 'live');
    const nestedWorkspace = join(savedOwner.directory, 'selected-workspace');
    await mkdir(nestedWorkspace);
    const nested = f.session('explicitly-selected', nestedWorkspace, 'released');
    f.sessions.save(nested);
    const nestedOwner = await f.scratch.allocate(nested);
    const ordinary = join(f.root, 'ordinary', 'nested-workspace');
    await mkdir(join(ordinary, '.git'), { recursive: true });
    await symlink(f.workspacePath, join(f.root, 'alias'));
    const catalog = new FilesystemWorkspaceCatalog(f.root);
    const discovered = await catalog.knownWorkspacePaths();
    expect(discovered).toContain(ordinary);
    expect(discovered.filter((path) => path === f.workspacePath)).toHaveLength(1);
    expect(discovered).not.toContain(orphan.directory);
    expect(discovered).not.toContain(nestedWorkspace);
    const cleanup = new CleanSessionScratch({
      sessions: () => f.sessions.list(),
      knownWorkspacePaths: async () => f.sessions.knownWorkspacePaths(),
      additionalWorkspacePaths: () => catalog.knownWorkspacePaths(),
      storage: new FilesystemScratchCleanup(),
    });
    const lease = await f.scratch.borrow(live);
    let instance: Awaited<ReturnType<typeof app>> | undefined;
    try {
      instance = await app(cleanup);
      const first = await instance.inject({
        method: 'POST',
        url: '/api/maintenance/clean-tmp',
        headers,
        payload: {},
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({
        status: 'complete',
        folders: { removed: 1, skipped: 3, failed: 0 },
        workspaces: { unavailable: 0, failed: 0 },
        reasons: { protected: 2, lease: 1, unavailable: 0, unsafe: 0, io: 0 },
      });
      await expect(
        readFile(join(orphan.directory, scratchMarkerName), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(savedOwner.directory, 'payload'), 'utf8')).toBe('saved');
      expect(await readFile(join(liveOwner.directory, 'payload'), 'utf8')).toBe('live');
      expect(await readFile(join(nestedOwner.directory, scratchMarkerName), 'utf8')).toContain(
        'explicitly-selected',
      );
      const repeated = await instance.inject({
        method: 'POST',
        url: '/api/maintenance/clean-tmp',
        headers,
        payload: {},
      });
      expect(repeated.json()).toMatchObject({
        status: 'complete',
        folders: { removed: 0, skipped: 3, failed: 0 },
        workspaces: { unavailable: 0 },
      });
    } finally {
      try {
        await instance?.close();
      } finally {
        await lease.release();
      }
    }
  });

  it('keeps CLI, service and detached borrower leases independently of the Mobile roster', async () => {
    const f = await fixture();
    const service = await f.scratch.allocateService(f.workspacePath, 'service-fixture');
    const cli = await cliOwner(f.workspacePath);
    const borrower = await cliOwner(f.workspacePath, true);
    const instance = await app(f.cleanup);
    try {
      const result = (
        await instance.inject({
          method: 'POST',
          url: '/api/maintenance/clean-tmp',
          headers,
          payload: {},
        })
      ).json();
      expect(result).toMatchObject({
        folders: { removed: 0, skipped: 3, failed: 0 },
        reasons: { busy: 1, lease: 2 },
      });
      expect(await readFile(join(cli, '.gestalt-owner.json'), 'utf8')).toContain('cli-session');
      expect(await readFile(join(borrower, '.gestalt-owner.json'), 'utf8')).toContain(
        'cli-session',
      );
    } finally {
      await instance.close();
      await service.release();
    }
  });

  it('reports a genuinely inaccessible workspace as partial while removing eligible folders elsewhere', async () => {
    const f = await fixture();
    await f.scratch.allocate(f.session('orphan'));
    const denied = join(f.root, 'denied');
    await mkdir(denied);
    await chmod(denied, 0);
    f.paths.push(join(denied, 'workspace'));
    const instance = await app(f.cleanup);
    try {
      const result = (
        await instance.inject({
          method: 'POST',
          url: '/api/maintenance/clean-tmp',
          headers,
          payload: {},
        })
      ).json();
      expect(result).toMatchObject({
        status: 'partial',
        folders: { removed: 1, failed: 0 },
        workspaces: { removed: 1, unavailable: 1 },
      });
    } finally {
      await chmod(denied, 0o700);
      await instance.close();
    }
  });

  it('retains durable known workspace discovery when a separate catalog source fails', async () => {
    const f = await fixture();
    const second = join(f.root, 'second');
    await mkdir(second);
    const old = f.session('old-selection', second);
    f.sessions.save(old);
    await f.scratch.allocate(old);
    f.sessions.remove(old.id);
    f.failCatalog();
    const instance = await app(f.cleanup);
    try {
      const result = (
        await instance.inject({
          method: 'POST',
          url: '/api/maintenance/clean-tmp',
          headers,
          payload: {},
        })
      ).json();
      expect(result).toMatchObject({
        status: 'partial',
        folders: { removed: 1, failed: 0 },
        workspaces: { cleaned: 2, removed: 1, unavailable: 0 },
        reasons: { unavailable: 1 },
      });
    } finally {
      await instance.close();
    }
  });

  it('reports a real folder deletion failure and its workspace, then removes it after repair', async () => {
    const f = await fixture();
    const context = await f.scratch.allocate(f.session('blocked-owner'));
    const blocked = join(context.directory, 'blocked');
    await mkdir(blocked);
    await writeFile(join(blocked, 'payload'), 'fixture');
    await chmod(blocked, 0o500);
    const container = join(f.workspacePath, 'tmp', 'sessions');
    const repair = async () => {
      for (const name of await readdir(container)) {
        if (name === context.ownerId || name.startsWith(`.cleanup-${context.ownerId}-`))
          await chmod(join(container, name, 'blocked'), 0o700).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
            },
          );
      }
    };
    const instance = await app(f.cleanup);
    try {
      const result = (
        await instance.inject({
          method: 'POST',
          url: '/api/maintenance/clean-tmp',
          headers,
          payload: {},
        })
      ).json();
      expect(result).toMatchObject({
        status: 'partial',
        folders: { removed: 0, failed: 1 },
        workspaces: { removed: 0, failed: 1 },
        reasons: { io: 1 },
      });
      await repair();
      expect(
        (
          await instance.inject({
            method: 'POST',
            url: '/api/maintenance/clean-tmp',
            headers,
            payload: {},
          })
        ).json(),
      ).toMatchObject({
        status: 'complete',
        folders: { removed: 1, failed: 0 },
        workspaces: { removed: 1, failed: 0 },
      });
    } finally {
      await repair();
      await instance.close();
    }
  });

  it('retains unmarked legacy candidates and persistent state instead of inferring ownership from names', async () => {
    const f = await fixture();
    const temporary = join(f.workspacePath, 'tmp');
    await mkdir(temporary);
    const legacy = await mkdtemp(join(temporary, 'gestalt-cli-playwright-'));
    const contextMode = await mkdtemp(join(temporary, '.ctx-mode-'));
    await writeFile(join(legacy, 'unmarked'), 'keep');
    await writeFile(join(contextMode, 'script.py'), 'print("keep")');
    const persistent = join(f.workspacePath, '.gestalt', 'context-mode');
    await mkdir(persistent, { recursive: true });
    await writeFile(join(persistent, 'keep.db'), 'persistent');
    const instance = await app(f.cleanup);
    try {
      const result = (
        await instance.inject({
          method: 'POST',
          url: '/api/maintenance/clean-tmp',
          headers,
          payload: {},
        })
      ).json();
      expect(result).toMatchObject({
        status: 'complete',
        folders: { removed: 0, skipped: 2, failed: 0 },
        reasons: { unrecognized: 2 },
      });
      expect(await readFile(join(legacy, 'unmarked'), 'utf8')).toBe('keep');
      expect(await readFile(join(contextMode, 'script.py'), 'utf8')).toContain('keep');
      expect(await readFile(join(persistent, 'keep.db'), 'utf8')).toBe('persistent');
    } finally {
      await instance.close();
    }
  });

  it('validates actual historical Mobile v1 allocations, deleting an orphan and keeping its saved sibling', async () => {
    const f = await fixture();
    const saved = f.session('historical-saved', f.workspacePath, 'released');
    const forgotten = f.session('historical-forgotten');
    f.sessions.save(saved);
    f.sessions.save(forgotten);
    f.sessions.remove(forgotten.id);
    // Execute the real immutable producer, not a marker invented by this test.
    // That allocator predates per-process leases but publishes the v1 authority.
    const producer = await readFile(
      join(process.cwd(), 'test', 'fixtures', 'scratch', 'mobile-v1-producer.ts.txt'),
      'utf8',
    );
    expect(createHash('sha256').update(producer).digest('hex')).toBe(
      '889e8b7785b6e18a8ff51b17c3d01f3992bcb8ea0f7724d616be31cd613ef916',
    );
    const source = join(f.root, 'historical-producer.ts');
    await writeFile(source, producer);
    await execute(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `
      import {writeFile} from 'node:fs/promises'; import {join} from 'node:path';
      const {FilesystemSessionScratch} = await import(${JSON.stringify(pathToFileURL(source).href)});
      const scratch = new FilesystemSessionScratch();
      for (const session of JSON.parse(process.argv[1])) {
        const context = await scratch.allocate(session);
        await writeFile(join(context.directory,'historical-payload'),'historical');
      }
    `,
        JSON.stringify([saved, forgotten]),
      ],
      { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeout: 2000 },
    );
    const instance = await app(f.cleanup);
    try {
      const result = (
        await instance.inject({
          method: 'POST',
          url: '/api/maintenance/clean-tmp',
          headers,
          payload: {},
        })
      ).json();
      expect(result).toMatchObject({
        status: 'complete',
        folders: { removed: 1, skipped: 1, failed: 0 },
        reasons: { protected: 1 },
      });
      const container = join(f.workspacePath, 'tmp', 'sessions');
      expect(
        await readFile(
          join(container, mobileScratchOwnerId(saved.id), 'historical-payload'),
          'utf8',
        ),
      ).toBe('historical');
      await expect(
        readFile(join(container, mobileScratchOwnerId(forgotten.id), 'historical-payload'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await instance.close();
    }
  });

  it('settles concurrent authorized cleanup calls without removing an owner twice', async () => {
    const f = await fixture();
    await f.scratch.allocate(f.session('orphan'));
    const instance = await app(f.cleanup);
    const calls = [
      instance.inject({ method: 'POST', url: '/api/maintenance/clean-tmp', headers, payload: {} }),
      instance.inject({ method: 'POST', url: '/api/maintenance/clean-tmp', headers, payload: {} }),
    ];
    try {
      const replies = await Promise.all(calls);
      expect(replies.every((reply) => reply.statusCode === 200)).toBe(true);
      expect(replies.reduce((sum, reply) => sum + reply.json().folders.removed, 0)).toBe(1);
      expect(replies.every((reply) => reply.json().folders.failed === 0)).toBe(true);
    } finally {
      await Promise.allSettled(calls);
      await instance.close();
    }
  });

  it('returns only bounded counts even if an adapter adds internal path/content fields', async () => {
    const internal = {
      ...snapshot(),
      entries: ['private contents'],
      path: '/private/path',
      workspaces: { ...snapshot().workspaces, path: '/private/workspace' },
      folders: { ...emptyScratchCounts(), path: '/private/folder' },
    };
    const instance = await app({ execute: async () => internal });
    try {
      const reply = await instance.inject({
        method: 'POST',
        url: '/api/maintenance/clean-tmp',
        headers,
        payload: {},
      });
      expect(reply.statusCode).toBe(200);
      expect(reply.body.length).toBeLessThan(1200);
      expect(Object.keys(reply.json()).sort()).toEqual(
        ['status', 'folders', 'workspaces', 'reasons'].sort(),
      );
      expect(reply.body).not.toMatch(/private|entries|path/);
    } finally {
      await instance.close();
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid/unbounded adapter counts %s',
    async (value) => {
      const instance = await app({
        execute: async () => ({
          ...snapshot(),
          folders: { ...emptyScratchCounts(), removed: value },
        }),
      });
      try {
        expect(
          (
            await instance.inject({
              method: 'POST',
              url: '/api/maintenance/clean-tmp',
              headers,
              payload: {},
            })
          ).statusCode,
        ).toBe(503);
      } finally {
        await instance.close();
      }
    },
  );

  it.each([
    undefined,
    {
      execute: async () => {
        throw new Error('/private/output');
      },
    },
  ])('reports unavailable cleanup without leaking adapter diagnostics', async (port) => {
    const instance = await app(port);
    try {
      const reply = await instance.inject({
        method: 'POST',
        url: '/api/maintenance/clean-tmp',
        headers,
        payload: {},
      });
      expect(reply.statusCode).toBe(503);
      expect(reply.json().code).toBe('TMP_CLEANUP_UNAVAILABLE');
      expect(reply.body).not.toContain('/private/');
    } finally {
      await instance.close();
    }
  });
});
