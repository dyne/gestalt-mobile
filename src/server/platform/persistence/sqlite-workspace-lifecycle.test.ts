/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import { registerStartSession } from '../../features/sessions/start-session/endpoint.js';
import { registerRestoreSession } from '../../features/sessions/restore-session/endpoint.js';
import { migrate } from './migrate.js';
import { SqliteSessionRepository } from './sqlite-session-repository.js';
import { SqliteWorkspaceLifecycle } from './sqlite-workspace-lifecycle.js';
import { SqliteForgetOperationStore } from './sqlite-forget-operation-store.js';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import { WorkspaceSessionConflict } from '../../features/sessions/application/workspace-conflict.js';
import { CodexSessionRuntime } from '../codex/session-runtime.js';

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  databases.splice(0).forEach((db) => db.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), 'tmp-workspace-test-'));
  roots.push(root);
  const path = join(root, 'relay.sqlite');
  const db = new DatabaseSync(path);
  databases.push(db);
  migrate(db);
  const sessions = new SqliteSessionRepository(db, new SqliteWorkspaceLifecycle(db));
  const session = (id: string, workspacePath = root) =>
    RelaySession.create({
      id,
      workspaceId: id,
      workspacePath,
      provider: 'codex',
      profile: 'default',
      effectiveSkillSelection: { skills: [] },
      now: '2026-01-01T00:00:00.000Z',
    }).snapshot;
  return { root, path, db, sessions, session, operations: new SqliteForgetOperationStore(db) };
}

it('atomically blocks a second running session across connections but allows saved sessions and other folders', async () => {
  const f = await fixture();
  f.sessions.save(f.session('first'));
  const second = new DatabaseSync(f.path);
  databases.push(second);
  const other = new SqliteSessionRepository(second, new SqliteWorkspaceLifecycle(second));
  expect(() => other.save(f.session('second'))).toThrow('already running');
  expect(() => other.save({ ...f.session('kimi'), provider: 'kimi' })).toThrow('already running');
  expect(other.find('second')).toBeNull();
  const saved = RelaySession.rehydrate(f.session('saved')).stop(
    '2026-01-01T00:00:01.000Z',
  ).snapshot;
  other.save(saved);
  expect(() =>
    other.save(RelaySession.rehydrate(saved).beginRecovery('2026-01-01T00:00:02.000Z').snapshot),
  ).toThrow('already running');
  const child = join(f.root, 'separate-folder');
  await mkdir(child);
  other.save(f.session('child', child));
  f.sessions.save(
    RelaySession.rehydrate(f.session('first')).stop('2026-01-01T00:00:03.000Z').snapshot,
  );
  other.save(RelaySession.rehydrate(saved).beginRecovery('2026-01-01T00:00:04.000Z').snapshot);
  expect(other.find('saved')?.desiredState).toBe('active');
});

it('preserves a workspace admission conflict during automatic writer acquisition before launching Codex', async () => {
  const f = await fixture();
  const conflict = new WorkspaceSessionConflict('SESSION_WORKSPACE_BUSY', 'running');
  const launch = vi.fn(() => {
    throw new Error('unexpected launch');
  });
  const args: ConstructorParameters<typeof CodexSessionRuntime> = [launch];
  args[15] = {
    reserveRuntime: () => {
      throw conflict;
    },
    allocate: async () => {
      throw new Error('unexpected allocation');
    },
    associateProviderThread: async () => {},
  };
  const runtime = new CodexSessionRuntime(...args);
  await expect(
    runtime.ensureWriter(
      { ...f.session('saved'), state: 'stopped', desiredState: 'stopped', threadId: 'history' },
      '2026-01-01T00:00:00.000Z',
    ),
  ).rejects.toBe(conflict);
  expect(launch).not.toHaveBeenCalled();
});

it('uses canonical folder identity for aliases', async () => {
  const f = await fixture();
  const alias = join(f.root, 'alias');
  await symlink(f.root, alias);
  f.sessions.save(f.session('first', alias));
  expect(f.sessions.find('first')?.workspacePath).toBe(f.root);
  expect(() => f.sessions.save(f.session('second'))).toThrow('already running');
});

it('returns the existing session in Start and Open conflicts before launching any runtime', async () => {
  const f = await fixture();
  f.sessions.save(f.session('running'));
  const saved = {
    ...RelaySession.rehydrate(f.session('saved')).stop('2026-01-01T00:00:00.000Z').snapshot,
    threadId: 'history',
  };
  f.sessions.save(saved);
  const app = await buildApp({
    health: {
      read: async () => {
        throw new Error('unused');
      },
    },
    logger: console,
  });
  const activate = vi.fn(async (session) => session);
  registerStartSession(app, {
    createId: () => 'new',
    now: () => '2026-01-01T00:00:00.000Z',
    save: (session) => f.sessions.save(session),
    activate,
    workspaces: { resolve: async () => ({ id: 'w', name: 'workspace', realPath: f.root }) },
    profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
    skillProfiles: {
      readGlobalProfile: async () => undefined,
      readWorkspaceDefault: async () => undefined,
    },
    skillCatalog: () => ({ list: async () => ({ skills: [], errors: [] }) }),
  });
  const restore = vi.fn(async (session) => session);
  registerRestoreSession(app, {
    find: (id) => f.sessions.find(id),
    save: (session) => f.sessions.save(session),
    restore,
  });
  try {
    const start = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { workspaceId: 'w', profile: 'default', provider: 'codex' },
    });
    expect(start.statusCode, start.body).toBe(409);
    expect(start.json()).toMatchObject({ code: 'SESSION_WORKSPACE_BUSY', sessionId: 'running' });
    expect(activate).not.toHaveBeenCalled();
    expect(f.sessions.find('new')).toBeNull();
    const opened = await app.inject({ method: 'POST', url: '/api/sessions/saved/restore' });
    expect(opened.statusCode, opened.body).toBe(409);
    expect(opened.json()).toMatchObject({ code: 'SESSION_WORKSPACE_BUSY', sessionId: 'running' });
    expect(restore).not.toHaveBeenCalled();
    expect(f.sessions.find('saved')?.state).toBe('stopped');
  } finally {
    await app.close();
  }
});

it('serializes Forget decisions across connections and fences new sessions inside tmp until finalization', async () => {
  const f = await fixture();
  const first = RelaySession.rehydrate(f.session('first')).stop('t').snapshot;
  const second = { ...first, id: 'second' };
  f.sessions.save(first);
  f.sessions.save(second);
  const operation = f.operations.begin(first.id)!;
  const reopened = new DatabaseSync(f.path);
  databases.push(reopened);
  const operations = new SqliteForgetOperationStore(reopened);
  const sessions = new SqliteSessionRepository(reopened, new SqliteWorkspaceLifecycle(reopened));
  expect(() => operations.begin(second.id)).toThrow('being forgotten');
  expect(operations.find(second.id)).toBeNull();
  expect(() => sessions.save(f.session('new'))).toThrow('being forgotten');
  expect(() => sessions.save(f.session('nested', join(f.root, 'tmp', 'nested')))).toThrow(
    'being forgotten',
  );
  f.operations.update({ ...operation, phase: 'finalizing' });
  f.operations.finalize({ ...operation, phase: 'finalizing' });
  expect(operations.begin(second.id)?.phase).toBe('stopping');
});
