/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexCapabilities } from '../codex/codex-capabilities.js';
import { CodexSerena } from '../codex/codex-serena.js';
import { serenaTools } from '../codex/managed-serena.js';
import { CodexSessionRuntime } from '../codex/session-runtime.js';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import { CodexXerj } from './codex-xerj.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const execute = promisify(execFile);
const roots: string[] = [];
const runtimes: CodexSessionRuntime[] = [];
afterEach(async () => {
  runtimes.splice(0).forEach((runtime) => runtime.stopAll());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'readiness-composition-'));
  roots.push(root);
  for (const fork of ['a', 'b']) {
    const directory = join(root, fork);
    await mkdir(join(directory, 'src'), { recursive: true });
    await mkdir(join(directory, 'build'));
    await mkdir(join(directory, '.serena'));
    await writeFile(join(directory, 'src/main.cpp'), `int ${fork}() { return 1; }\n`);
    await writeFile(join(directory, 'src/other.cpp'), 'int other() { return 0; }\n');
    await writeFile(join(directory, '.serena/project.yml'), 'project_name: project\n');
    await writeFile(
      join(directory, 'compile_commands.json'),
      JSON.stringify([
        {
          directory,
          file: 'src/main.cpp',
          arguments: ['clang++', '-D' + fork.toUpperCase(), 'src/main.cpp'],
        },
        {
          directory: join(directory, 'build'),
          file: '../src/main.cpp',
          arguments: ['clang++', '-DALIAS', '../src/main.cpp'],
        },
      ]),
    );
    await execute('git', ['init', '-q'], { cwd: directory });
    await execute('git', ['add', '.'], { cwd: directory });
    await execute(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'fixture',
      ],
      { cwd: directory },
    );
  }
  const skill = join(root, 'SKILL.md');
  await writeFile(skill, '# Serena fixture\n');
  const cwd = new Map([
    ['root-thread', root],
    ['child-a', join(root, 'a')],
    ['child-b', join(root, 'b')],
  ]);
  let listener: (event: { method: string; params: unknown }) => void = () => {};
  let configuration: Record<string, unknown> = { features: { hooks: true } };
  let toolGeneration = 1;
  let parent = 'root-thread';
  const rpc = {
    request: vi.fn(async (method: string, params: unknown): Promise<unknown> => {
      const threadId = (params as { threadId?: string }).threadId;
      if (method === 'config/read') return { config: configuration };
      if (method === 'thread/read')
        return {
          thread: {
            id: threadId,
            cwd: cwd.get(threadId!),
            parentThreadId: threadId === 'root-thread' ? undefined : parent,
            status: { type: 'idle' },
          },
        };
      if (method === 'thread/start') return { thread: { id: 'root-thread' } };
      if (method === 'mcpServerStatus/list')
        return {
          data: [
            {
              name: 'gestalt-serena',
              runtimeStatus: 'connected',
              tools: Object.fromEntries(
                [...serenaTools, 'find_referencing_symbols'].map((tool) => [
                  tool,
                  { generation: toolGeneration },
                ]),
              ),
            },
          ],
        };
      return {};
    }),
    onNotification: (fn: typeof listener) => {
      listener = fn;
      return () => {};
    },
    onServerRequest: () => () => {},
  };
  const capabilities = new CodexCapabilities(
    new CodexXerj({ check: async () => ({ status: 'absent' }) }),
    new CodexSerena({
      check: async () => ({ status: 'installed', manager: '/fixture/gestalt', version: '1.7.0' }),
    }),
  );
  const input = {
    cwd: root,
    deadline: Date.now() + 5000,
    rpc,
    skills: [{ name: 'gestalt:serena', path: skill, enabled: true }],
    skillsConfig: [{ path: skill, enabled: true }],
    config: { sandbox_mode: 'read-only', approval_policy: 'never' },
    start: false,
  };
  const prepared = await capabilities.prepare(input);
  await capabilities.verify(rpc, 'root-thread', prepared);
  const observer = prepared.repositories!;
  const setPolicy = async (threadId: string, settings: unknown) =>
    observer.observe(
      rpc,
      'root-thread',
      {
        method: 'thread/settings/updated',
        params: { threadId, threadSettings: settings },
      },
      () => true,
    );
  for (const [threadId, directory] of cwd)
    await setPolicy(threadId, {
      cwd: directory,
      activePermissionProfile: null,
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [directory] },
    });
  let active = true;
  let next = 0;
  const current = () => active;
  const start = async (
    threadId = 'child-a',
    path = 'a/src/main.cpp',
    tool = 'get_symbols_overview',
  ) => {
    const item = {
      id: String(++next),
      type: 'mcpToolCall',
      server: 'gestalt-serena',
      tool,
      arguments: { relative_path: path },
    };
    await observer.observe(
      rpc,
      'root-thread',
      { method: 'item/started', params: { threadId, item } },
      current,
    );
    return { threadId, item };
  };
  const complete = async (
    request: Awaited<ReturnType<typeof start>>,
    output: unknown = [{ name_path: 'main', kind: 12 }],
    extras: Record<string, unknown> = {},
  ) => {
    await observer.observe(
      rpc,
      'root-thread',
      {
        method: 'item/completed',
        params: {
          threadId: request.threadId,
          item: {
            ...request.item,
            status: 'completed',
            result: { content: [{ type: 'text', text: JSON.stringify(output) }] },
            ...extras,
          },
        },
      },
      current,
    );
  };
  return {
    root,
    rpc,
    capabilities,
    input,
    prepared,
    observer,
    cwd,
    start,
    complete,
    snapshots: () => observer.snapshot(rpc, 'root-thread', current),
    setConfig: () => {
      configuration = { ...configuration, generation: 2 };
    },
    setRestricted: (denied: string) => {
      configuration = {
        ...configuration,
        permissions: {
          restricted: { file_system: { [root]: 'read', [join(root, denied)]: 'none' } },
        },
      };
    },
    setPolicy,
    setTools: () => {
      toolGeneration++;
    },
    setParent: (value: string) => {
      parent = value;
    },
    close: () => {
      active = false;
    },
    emit: (event: Parameters<typeof listener>[0]) => listener(event),
  };
}

it('composes fork/source/build/child evidence without changing workspace, aliases or permissions', async () => {
  const f = await fixture();
  const configBefore = JSON.stringify(f.prepared.config);
  const compileBefore = await readFile(join(f.root, 'a/compile_commands.json'), 'utf8');
  const indexBefore = await readFile(join(f.root, 'a/.git/index'));
  const projectBefore = await readFile(join(f.root, 'a/.serena/project.yml'), 'utf8');
  await f.complete(await f.start());
  await f.complete(await f.start('child-b', 'b/src/main.cpp'));
  const snapshots = await f.snapshots();
  expect(snapshots.map((value) => value.threadId)).toEqual(['child-a', 'child-b']);
  expect(snapshots[0].readiness.repository?.id).not.toBe(snapshots[1].readiness.repository?.id);
  for (const value of snapshots) {
    expect(value.readiness.symbols.state).toBe('ready');
    expect(value.readiness.repository?.buildIds).toHaveLength(2);
    expect(value.readiness.references.state).toBe('unknown');
    expect(value.readiness.coverage.state).toBe('unknown');
  }
  expect(await readFile(join(f.root, 'a/compile_commands.json'), 'utf8')).toBe(compileBefore);
  expect(await readFile(join(f.root, 'a/.serena/project.yml'), 'utf8')).toBe(projectBefore);
  expect(await readFile(join(f.root, 'a/.git/index'))).toEqual(indexBefore);
  await expect(readFile(join(f.root, 'a/.xerjignore'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.stringify(f.prepared.config)).toBe(configBefore);
  expect(f.input.cwd).toBe(f.root);
  expect(f.prepared.config).toMatchObject({ sandbox_mode: 'read-only', approval_policy: 'never' });
  expect(JSON.stringify(snapshots)).not.toContain(f.root);
  expect(
    f.rpc.request.mock.calls.every(([method]) =>
      ['config/read', 'mcpServerStatus/list', 'thread/read'].includes(method),
    ),
  ).toBe(true);
});

it.each([
  { output: [] },
  { output: {} },
  { output: 'successful' },
  { output: [{ name_path: 'main' }] },
])('keeps successful but inadequate output unverified: %j', async ({ output }) => {
  const f = await fixture();
  await f.complete(await f.start(), output);
  expect((await f.snapshots())[0].readiness.symbols.state).toBe('unknown');
});

it('requires usable same-repository references and matching C++ compilation inputs', async () => {
  const f = await fixture();
  await f.complete(await f.start());
  await f.complete(await f.start('child-a', 'a/src/main.cpp', 'find_referencing_symbols'), []);
  expect((await f.snapshots())[0].readiness.references.state).toBe('unknown');
  await f.complete(await f.start('child-a', 'a/src/main.cpp', 'find_referencing_symbols'), [
    { name_path: 'caller', kind: 12, relative_path: 'b/src/main.cpp' },
  ]);
  expect((await f.snapshots())[0].readiness.references.state).not.toBe('ready');
  await f.complete(await f.start('child-a', 'a/src/main.cpp', 'find_referencing_symbols'), [
    { name_path: 'caller', kind: 12, relative_path: 'a/src/main.cpp' },
  ]);
  expect((await f.snapshots())[0].readiness.references.state).toBe('ready');
  await rm(join(f.root, 'a/compile_commands.json'));
  await f.complete(await f.start('child-a', 'a/src/main.cpp', 'find_referencing_symbols'), [
    { name_path: 'caller', kind: 12, relative_path: 'a/src/main.cpp' },
  ]);
  expect((await f.snapshots())[0].readiness.references.state).not.toBe('ready');
});

it('recognizes installed Serena grouped symbol/reference output while rejecting counters and errors', async () => {
  const f = await fixture();
  await f.complete(await f.start(), { Function: 3 });
  expect((await f.snapshots())[0].readiness.symbols.state).toBe('unknown');
  await f.complete(await f.start(), {
    Function: ['main'],
    Class: [{ Container: { Method: ['run'] } }],
  });
  expect((await f.snapshots())[0].readiness.symbols.state).toBe('ready');
  await f.complete(await f.start('child-a', 'a/src/main.cpp', 'find_referencing_symbols'), {
    'a/src/main.cpp': {
      Function: [
        {
          name_path: 'caller',
          body_location: { start_line: 0, end_line: 1 },
          content_around_reference: '1: main();',
        },
      ],
    },
  });
  expect((await f.snapshots())[0].readiness.references.state).toBe('ready');
  await f.complete(await f.start('child-a', 'a/src/main.cpp', 'find_referencing_symbols'), [], {
    status: 'failed',
    error: { message: 'private failure' },
  });
  const snapshot = (await f.snapshots())[0].readiness;
  expect(snapshot.symbols.state).toBe('ready');
  expect(snapshot.references.state).toBe('unavailable');
  expect(JSON.stringify(snapshot)).not.toContain('private failure');
});

it.each(['source', 'other-source', 'compile', 'project', 'runtime-config', 'tools'] as const)(
  'invalidates observed results after %s changes, even while already dirty',
  async (change) => {
    const f = await fixture();
    await writeFile(join(f.root, 'a/src/main.cpp'), 'int dirty() { return 2; }');
    await f.complete(await f.start());
    expect((await f.snapshots())[0].readiness.symbols.state).toBe('ready');
    if (change === 'source')
      await writeFile(join(f.root, 'a/src/main.cpp'), 'int changed() { return 3; }');
    if (change === 'other-source')
      await writeFile(join(f.root, 'a/src/other.cpp'), 'int other() { return 9; }\n');
    if (change === 'compile') await writeFile(join(f.root, 'a/compile_commands.json'), '[]');
    if (change === 'project')
      await writeFile(join(f.root, 'a/.serena/project.yml'), 'project_name: changed\n');
    if (change === 'runtime-config') f.setConfig();
    if (change === 'tools') f.setTools();
    expect((await f.snapshots())[0].readiness.symbols.state).toBe('stale');
    await f.complete(await f.start());
    expect((await f.snapshots())[0].readiness.symbols.state).toBe('ready');
  },
);

it('rejects late results after edits, generation changes, disconnects and writer release', async () => {
  const f = await fixture();
  const started = await f.start();
  await writeFile(join(f.root, 'a/src/main.cpp'), 'int changed() { return 2; }');
  await f.complete(started);
  expect((await f.snapshots())[0].readiness.symbols.state).not.toBe('ready');
  const next = await f.start();
  await f.observer.observe(
    f.rpc,
    'root-thread',
    { method: 'mcpServer/statusUpdated', params: { name: 'gestalt-serena', status: 'failed' } },
    () => true,
  );
  await f.complete(next);
  expect((await f.snapshots())[0].readiness.symbols.state).not.toBe('ready');
  const released = await f.start();
  f.close();
  await f.complete(released);
  expect(await f.snapshots()).toEqual([]);
});

it('rejects canonical symlink escapes, cross-child files and mismatched parent provenance', async () => {
  const f = await fixture();
  await symlink(join(f.root, 'b/src/main.cpp'), join(f.root, 'a/src/escape.cpp'));
  await f.complete(await f.start('child-a', 'a/src/escape.cpp'));
  await f.complete(await f.start('child-a', 'b/src/main.cpp'));
  f.setParent('different-root');
  await f.complete(await f.start());
  expect(await f.snapshots()).toEqual([]);
});

it.each([
  'a/src/main.cpp',
  'a/compile_commands.json',
  'a/.serena/project.yml',
  'a/build',
  'a/src/other.cpp',
])('does not read contained inputs when a selected profile may deny %s', async (denied) => {
  const f = await fixture();
  f.setRestricted(denied);
  await f.setPolicy('child-a', {
    cwd: join(f.root, 'a'),
    activePermissionProfile: { id: 'restricted' },
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [join(f.root, 'a')] },
  });
  vi.mocked(readFile).mockClear();
  await f.complete(await f.start());
  expect(await f.snapshots()).toEqual([]);
  expect(readFile).not.toHaveBeenCalled();
});

it.each([
  undefined,
  {},
  { sandboxPolicy: { type: 'externalSandbox' } },
  { sandboxPolicy: { type: 'new-policy' } },
  { sandboxPolicy: { type: 'readOnly', readAccess: { type: 'restricted' } } },
])('does not read source with unknown effective permission evidence: %j', async (policy) => {
  const f = await fixture();
  await f.setPolicy('child-a', policy ? { ...policy, cwd: join(f.root, 'a') } : undefined);
  vi.mocked(readFile).mockClear();
  await f.complete(await f.start());
  expect(await f.snapshots()).toEqual([]);
  expect(readFile).not.toHaveBeenCalled();
});

it('invalidates references on untracked header addition, edit and deletion without fileChange events', async () => {
  const f = await fixture();
  const references = async () =>
    f.complete(await f.start('child-a', 'a/src/main.cpp', 'find_referencing_symbols'), [
      { name_path: 'caller', kind: 12, relative_path: 'a/src/main.cpp' },
    ]);
  await references();
  expect((await f.snapshots())[0].readiness.references.state).toBe('ready');
  const header = join(f.root, 'a/src/untracked.hpp');
  await writeFile(header, 'int added();\n');
  expect((await f.snapshots())[0].readiness.references.state).toBe('stale');
  await references();
  expect((await f.snapshots())[0].readiness.references.state).toBe('ready');
  await writeFile(header, 'int changed();\n');
  expect((await f.snapshots())[0].readiness.references.state).toBe('stale');
  await references();
  expect((await f.snapshots())[0].readiness.references.state).toBe('ready');
  await rm(header);
  expect((await f.snapshots())[0].readiness.references.state).toBe('stale');
  await references();
  expect((await f.snapshots())[0].readiness.references.state).toBe('ready');
});

it('keeps evidence unknown when the bounded untracked input scope is exhausted', async () => {
  const f = await fixture();
  await Promise.all(
    Array.from({ length: 129 }, (_, index) =>
      writeFile(join(f.root, `a/src/new-${index}.hpp`), 'int untracked();'),
    ),
  );
  await f.complete(await f.start());
  expect(await f.snapshots()).toEqual([]);
});

it('rechecks actual permission evidence after awaiting child connection metadata, before host reads', async () => {
  const f = await fixture();
  const request = f.rpc.request.getMockImplementation()!;
  f.rpc.request.mockImplementation(async (method, params) => {
    if (method === 'mcpServerStatus/list') await f.setPolicy('child-a', undefined);
    return request(method, params);
  });
  vi.mocked(readFile).mockClear();
  await f.complete(await f.start());
  expect(await f.snapshots()).toEqual([]);
  expect(readFile).not.toHaveBeenCalled();
});

it.each(['readOnly', 'dangerFullAccess'])(
  'accepts observed unrestricted-read %s policies without changing source authority',
  async (type) => {
    const f = await fixture();
    await f.setPolicy('child-a', {
      cwd: join(f.root, 'a'),
      activePermissionProfile: null,
      sandboxPolicy: { type },
    });
    await f.complete(await f.start());
    expect((await f.snapshots())[0].readiness.symbols.state).toBe('ready');
    await f.setPolicy('child-a', undefined);
    vi.mocked(readFile).mockClear();
    expect((await f.snapshots())[0].readiness.symbols.state).toBe('stale');
    expect(readFile).not.toHaveBeenCalled();
  },
);

it('does not infer evidence from fast completion before its start capture, or change the active project', async () => {
  const f = await fixture();
  const item = {
    id: 'fast',
    type: 'mcpToolCall',
    server: 'gestalt-serena',
    tool: 'get_symbols_overview',
    arguments: { relative_path: 'a/src/main.cpp' },
  };
  const started = f.observer.observe(
    f.rpc,
    'root-thread',
    { method: 'item/started', params: { threadId: 'child-a', item } },
    () => true,
  );
  await f.observer.observe(
    f.rpc,
    'root-thread',
    {
      method: 'item/completed',
      params: {
        threadId: 'child-a',
        item: {
          ...item,
          status: 'completed',
          result: { structuredContent: { Function: ['main'] } },
        },
      },
    },
    () => true,
  );
  await started;
  expect((await f.snapshots())[0].readiness.symbols.state).toBe('unknown');
  await f.complete(await f.start());
  await f.observer.observe(
    f.rpc,
    'root-thread',
    {
      method: 'item/started',
      params: { threadId: 'child-a', item: { ...item, id: 'switch', tool: 'activate_project' } },
    },
    () => true,
  );
  await f.complete(await f.start());
  expect((await f.snapshots())[0].readiness.symbols.state).toBe('stale');
  expect(f.rpc.request.mock.calls.some(([method]) => method === 'mcpServer/tool/call')).toBe(false);
});

it('wires native operation notifications into the owning runtime and resets after resume/fresh initialization', async () => {
  const f = await fixture();
  const notifications = vi.fn();
  const runtime = new CodexSessionRuntime(
    () => ({ rpc: f.rpc, close: () => {} }),
    undefined,
    notifications,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    64,
    undefined,
    undefined,
    {
      prepare: async (_session, rpc, config, deadline) =>
        f.capabilities.prepare({ ...f.input, rpc, config, deadline }),
      verify: (rpc, threadId, state) => f.capabilities.verify(rpc, threadId, state),
    },
  );
  runtimes.push(runtime);
  const initial = RelaySession.create({
    id: 'session',
    provider: 'codex',
    workspaceId: 'workspace',
    workspacePath: f.root,
    profile: 'default',
    effectiveSkillSelection: { skills: f.input.skills },
    now: 'now',
  }).snapshot;
  const session = await runtime.start(initial, 'now');
  f.emit({
    method: 'thread/settings/updated',
    params: {
      threadId: 'child-a',
      threadSettings: {
        cwd: join(f.root, 'a'),
        activePermissionProfile: null,
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [join(f.root, 'a')] },
      },
    },
  });
  const item = {
    id: 'runtime-probe',
    type: 'mcpToolCall',
    server: 'gestalt-serena',
    tool: 'get_symbols_overview',
    arguments: { relative_path: 'a/src/main.cpp' },
  };
  f.emit({ method: 'item/started', params: { threadId: 'child-a', item } });
  await vi.waitFor(async () =>
    expect((await runtime.readRetrievalReadiness(session.id))?.repositories).toHaveLength(1),
  );
  f.emit({
    method: 'item/completed',
    params: {
      threadId: 'child-a',
      item: {
        ...item,
        status: 'completed',
        result: { content: [{ type: 'text', text: '[{"name_path":"a","kind":12}]' }] },
      },
    },
  });
  await vi.waitFor(async () =>
    expect(
      (await runtime.readRetrievalReadiness(session.id))?.repositories[0].readiness.symbols.state,
    ).toBe('ready'),
  );
  await vi.waitFor(() =>
    expect(
      notifications.mock.calls.filter(([, event]) => event.method === 'gestalt/retrievalReadiness'),
    ).toHaveLength(1),
  );
  await runtime.release(session.id);
  expect(await runtime.readRetrievalReadiness(session.id)).toBeNull();
  const restored = await runtime.restore(session, 'later');
  expect((await runtime.readRetrievalReadiness(session.id))?.repositories).toEqual([]);
  await runtime.recycle(restored, 'latest');
  expect((await runtime.readRetrievalReadiness(session.id))?.repositories).toEqual([]);
  expect(restored.workspacePath).toBe(f.root);
});
