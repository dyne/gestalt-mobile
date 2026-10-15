/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import {
  CodexSessionRuntime,
  type AppServer,
  type AppServerLaunchInput,
} from '../codex/session-runtime.js';
import { observeLiveProcess } from './process-identity.js';

function session() {
  return RelaySession.create({
    id: 'owning-session',
    provider: 'codex',
    workspaceId: 'workspace',
    workspacePath: process.cwd(),
    profile: 'default',
    model: 'selected-model',
    effectiveSkillSelection: { skills: [] },
    now: 'time',
  }).snapshot;
}
// Deterministic RPC fixture; the Linux observation test separately uses an actual owned child.
function fixture(
  observe = true,
  hooks: {
    beforeLaunch?: ConstructorParameters<typeof CodexSessionRuntime>[16];
    beforeThread?: ConstructorParameters<typeof CodexSessionRuntime>[17];
  } = {},
) {
  const calls: { method: string; params: unknown }[] = [];
  let configuration: () => Promise<unknown> = async () => ({ config: {}, layers: [] });
  let children: () => Promise<unknown> = async () => ({ data: [], nextCursor: null });
  let mcp: (params: unknown) => Promise<unknown> = async () => ({ data: [], nextCursor: null });
  let mcpTool: (params: unknown) => Promise<unknown> = async () => ({});
  let notify: Parameters<AppServer['rpc']['onNotification']>[0] = () => {};
  const process: AppServer = {
    rpc: {
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === 'thread/start')
          return {
            thread: { id: 'same-thread' },
            model: 'selected-model',
            cwd: globalThis.process.cwd(),
            activePermissionProfile: { id: 'workspace-git', extends: ':workspace' },
            runtimeWorkspaceRoots: [globalThis.process.cwd()],
            sandbox: { type: 'workspaceWrite', networkAccess: false },
            instructionSources: [],
          };
        if (method === 'config/read') return configuration();
        if (method === 'thread/list') return children();
        if (method === 'thread/read') {
          const id = (params as { threadId: string }).threadId;
          return {
            thread:
              id === 'same-thread'
                ? {
                    id,
                    sessionId: 'native-session',
                    parentThreadId: null,
                    status: { type: 'idle' },
                  }
                : ((await children()) as { data: { id: string }[] }).data.find(
                    (thread) => thread.id === id,
                  ),
          };
        }
        if (method === 'mcpServerStatus/list') return mcp(params);
        if (method === 'mcpServer/tool/call') return mcpTool(params);
        return {};
      },
      onNotification: (listener) => {
        notify = listener;
        return () => {};
      },
      onServerRequest: () => () => {},
    },
    close: vi.fn(),
    ...(observe ? { observeLiveLaunch: () => observeLiveProcess(globalThis.process.pid) } : {}),
  };
  const launch = vi.fn<(input: AppServerLaunchInput) => AppServer>(() => process);
  const arguments_: ConstructorParameters<typeof CodexSessionRuntime> = [launch];
  arguments_[16] = hooks.beforeLaunch;
  arguments_[17] = hooks.beforeThread;
  const runtime = new CodexSessionRuntime(...arguments_);
  return {
    runtime,
    launch,
    calls,
    notify: (notification: Parameters<typeof notify>[0]) => notify(notification),
    setConfiguration: (read: typeof configuration) => {
      configuration = read;
    },
    setChildren: (read: typeof children) => {
      children = read;
    },
    setMcp: (read: typeof mcp) => {
      mcp = read;
    },
    setMcpTool: (call: typeof mcpTool) => {
      mcpTool = call;
    },
  };
}
describe('owning runtime admission observations', () => {
  it.each(['module', 'commonjs'])(
    'executes the denial probe in a %s app and refuses readable private state',
    async (type) => {
      const directory = mkdtempSync(join(tmpdir(), 'live-context-module-'));
      const canary = join(directory, 'canary');
      writeFileSync(canary, Buffer.alloc(32), { mode: 0o600 });
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ type }));
      const f = fixture();
      try {
        const owning = await f.runtime.start(session(), 'time');
        f.setMcpTool(async (params) => {
          const request = params as {
            threadId: string;
            server: string;
            tool: string;
            arguments: { code: string };
          };
          expect(request).toMatchObject({
            threadId: owning.threadId,
            server: 'context-mode',
            tool: 'ctx_execute',
          });
          const script = join(directory, 'probe.js');
          // Match the context wrapper's module-scoped require handling. This
          // process deliberately has no sandbox, so readable state must refuse.
          writeFileSync(
            script,
            `(function(require){async function run(){${request.arguments.code}}run().catch(()=>{process.exitCode=1});})(typeof require!=='undefined'?require:null);`,
          );
          const text = execFileSync(process.execPath, [script], { encoding: 'utf8' });
          expect(text.trim()).toBe('LIVE_ADMISSION_PROBE_V1:{"privateReadDenied":false}');
          return { content: [{ type: 'text', text }] };
        });
        await expect(f.runtime.probeLiveContext(owning, canary)).rejects.toMatchObject({
          message: 'LIVE_CONTEXT_PROBE_UNAVAILABLE',
          stage: 'context-denial-not-proven',
        });
      } finally {
        f.runtime.stopAll();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it('does not renew a disposed captured owner through ordinary rollback restoration', async () => {
    const beforeLaunch = vi.fn(async (_session, input) => ({
      ...input,
      liveCaptureId: 'original-capture',
    }));
    const f = fixture(true, { beforeLaunch });
    const owning = await f.runtime.start(session(), 'time');
    f.runtime.stop(owning.id);
    await expect(
      f.runtime.restoreLiveOwner(owning, 'later', { modelConfig: {}, skillsConfig: undefined }),
    ).rejects.toThrow('LIVE_RUNTIME_RENEWAL_REQUIRED');
    expect(beforeLaunch).toHaveBeenCalledTimes(1);
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.runtime.liveOwnerIds()).toEqual([]);
  });
  it('awaits private capture before launching the original process and refuses a failed capture', async () => {
    const beforeLaunch = vi.fn(async (_session, input) => ({
      ...input,
      liveCaptureId: 'controller-token',
    }));
    const f = fixture(true, { beforeLaunch });
    try {
      await f.runtime.start(session(), 'time');
      expect(beforeLaunch).toHaveBeenCalledTimes(1);
      expect(f.launch.mock.calls[0]![0]).toMatchObject({ liveCaptureId: 'controller-token' });
    } finally {
      f.runtime.stopAll();
    }
    const denied = fixture(true, {
      beforeLaunch: async () => {
        throw new Error('LIVE_RUNTIME_PROVENANCE_UNAVAILABLE');
      },
    });
    await expect(denied.runtime.start(session(), 'time')).rejects.toThrow(
      'LIVE_RUNTIME_PROVENANCE_UNAVAILABLE',
    );
    expect(denied.launch).not.toHaveBeenCalled();
  });
  it('checks final original thread flags before native startup can execute configured delegates', async () => {
    const beforeThread = vi.fn(() => {
      throw new Error('LIVE_ORIGINAL_LAUNCH_UNVERIFIED');
    });
    const f = fixture(true, { beforeThread });
    await expect(f.runtime.start(session(), 'time')).rejects.toThrow(
      'LIVE_ORIGINAL_LAUNCH_UNVERIFIED',
    );
    expect(beforeThread).toHaveBeenCalledTimes(1);
    expect(f.calls.some((call) => call.method === 'initialize')).toBe(true);
    expect(f.calls.some((call) => call.method === 'thread/start')).toBe(false);
    expect(f.runtime.liveOwnerIds()).toEqual([]);
  });
  it('enumerates native spawned children through the sole owner without detached readers or resume', async () => {
    const { runtime, launch, calls, setChildren } = fixture();
    const owning = await runtime.start(session(), 'time');
    setChildren(async () => ({
      data: [
        {
          id: 'actual-child',
          parentThreadId: owning.threadId,
          sessionId: 'native-session',
          model: 'selected-model',
          reasoningEffort: 'medium',
          status: { type: 'idle' },
        },
      ],
      nextCursor: null,
    }));
    try {
      const before = calls.length;
      const roster = await runtime.inspectLiveSpawnedChildren(owning);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(calls.slice(before)).toEqual([
        { method: 'thread/read', params: { threadId: owning.threadId, includeTurns: false } },
        {
          method: 'thread/list',
          params: {
            sourceKinds: [
              'subAgent',
              'subAgentReview',
              'subAgentCompact',
              'subAgentThreadSpawn',
              'subAgentOther',
            ],
            limit: 64,
          },
        },
        { method: 'thread/read', params: { threadId: 'actual-child', includeTurns: false } },
      ]);
      expect(roster.threads[0]).toMatchObject({
        id: 'actual-child',
        model: 'selected-model',
        reasoningEffort: 'medium',
      });
    } finally {
      runtime.stopAll();
    }
  });
  it('ignores unrelated global children and refuses changed lineage before adopting an own child', async () => {
    const f = fixture();
    const owning = await f.runtime.start(session(), 'time');
    const own = {
      id: 'own-child',
      parentThreadId: owning.threadId,
      sessionId: 'native-session',
      status: { type: 'idle' },
    };
    const foreign = {
      id: 'foreign',
      parentThreadId: 'other-root',
      sessionId: 'other-session',
      status: { type: 'idle' },
    };
    f.setChildren(async () => ({ data: [own, foreign] }));
    try {
      expect(
        (await f.runtime.inspectLiveSpawnedChildren(owning)).threads.map((thread) => thread.id),
      ).toEqual(['own-child']);
      let reads = 0;
      f.setChildren(async () => ({
        data: [++reads === 1 ? own : { ...own, parentThreadId: 'retargeted-root' }],
      }));
      await expect(f.runtime.inspectLiveSpawnedChildren(owning)).rejects.toThrow(
        'LIVE_CHILD_TOPOLOGY_UNAVAILABLE',
      );
    } finally {
      f.runtime.stopAll();
    }
  });
  it.each([
    { data: [{ id: 'foreign', parentThreadId: 'same-thread', sessionId: 'another-session' }] },
    {
      data: [
        { id: 'duplicate', parentThreadId: 'same-thread', sessionId: 'native-session' },
        { id: 'duplicate', parentThreadId: 'same-thread', sessionId: 'native-session' },
      ],
    },
    { data: [], nextCursor: 'incomplete-roster' },
  ])('refuses foreign, ambiguous or incomplete Live child topology', async (reply) => {
    const { runtime, setChildren } = fixture();
    const owning = await runtime.start(session(), 'time');
    setChildren(async () => reply);
    try {
      await expect(runtime.inspectLiveSpawnedChildren(owning)).rejects.toThrow(
        'LIVE_CHILD_TOPOLOGY_UNAVAILABLE',
      );
    } finally {
      runtime.stopAll();
    }
  });
  it('fences a lost owner during Live child enumeration', async () => {
    const { runtime, setChildren } = fixture();
    const owning = await runtime.start(session(), 'time');
    let release: (value: unknown) => void = () => {};
    let entered!: () => void;
    const listing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    setChildren(
      () =>
        new Promise((resolve) => {
          release = resolve;
          entered();
        }),
    );
    const pending = runtime.inspectLiveSpawnedChildren(owning);
    await listing;
    runtime.stopAll();
    release({ data: [] });
    await expect(pending).rejects.toThrow('LIVE_RUNTIME_IDENTITY_CHANGED');
  });
  it('observes native profile provenance and ignores a different child thread settings update', async () => {
    const { runtime, notify } = fixture();
    const owning = await runtime.start(session(), 'time');
    try {
      const first = await runtime.inspectLiveAdmission(owning);
      expect(first.threadSelection?.activePermissionProfile).toEqual({
        id: 'workspace-git',
        extends: ':workspace',
      });
      (first.threadSelection?.activePermissionProfile as { id: string }).id = 'tampered-copy';
      notify({
        method: 'thread/settings/updated',
        params: {
          threadId: 'other-child',
          threadSettings: { activePermissionProfile: { id: ':full' } },
        },
      });
      expect(
        (await runtime.inspectLiveAdmission(owning)).threadSelection?.activePermissionProfile,
      ).toEqual({ id: 'workspace-git', extends: ':workspace' });
      notify({
        method: 'thread/settings/updated',
        params: {
          threadId: owning.threadId,
          threadSettings: {
            model: 'selected-model',
            cwd: owning.workspacePath,
            activePermissionProfile: { id: 'workspace-git', extends: ':workspace' },
            sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
            effort: 'medium',
          },
        },
      });
      expect(
        (await runtime.inspectLiveAdmission(owning)).threadSelection?.runtimeWorkspaceRoots,
      ).toEqual([owning.workspacePath]);
      notify({
        method: 'thread/settings/updated',
        params: {
          threadId: owning.threadId,
          threadSettings: {
            model: 'changed-model',
            cwd: owning.workspacePath,
            activePermissionProfile: { id: ':readOnly' },
            effort: 'low',
          },
        },
      });
      const changed = (await runtime.inspectLiveAdmission(owning)).threadSelection;
      expect(changed?.activePermissionProfile).toEqual({ id: ':readOnly' });
      expect(changed?.model).toBe('changed-model');
      expect(changed?.runtimeWorkspaceRoots).toBeUndefined();
    } finally {
      runtime.stopAll();
    }
  });
  it('reads the existing thread, effective layers and actual MCP without launching another runtime', async () => {
    const { runtime, launch, calls } = fixture();
    const owning = await runtime.start(session(), 'time');
    try {
      const before = calls.length;
      const result = await runtime.inspectLiveAdmission(owning);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(calls.slice(before)).toEqual([
        {
          method: 'mcpServerStatus/list',
          params: { threadId: 'same-thread', serverName: 'context-mode', detail: 'full' },
        },
        {
          method: 'mcpServerStatus/list',
          params: { threadId: 'same-thread', serverName: 'gestalt-org-plan', detail: 'full' },
        },
        { method: 'config/read', params: { cwd: owning.workspacePath, includeLayers: true } },
        { method: 'thread/read', params: { threadId: 'same-thread', includeTurns: false } },
      ]);
      expect(result.thread).toEqual({
        thread: {
          id: owning.threadId,
          sessionId: 'native-session',
          parentThreadId: null,
          status: { type: 'idle' },
        },
      });
      await expect(runtime.inspectLiveAdmission({ ...owning, provider: 'kimi' })).rejects.toThrow(
        'LIVE_RUNTIME_UNAVAILABLE',
      );
      await expect(
        runtime.inspectLiveAdmission({ ...owning, threadId: 'foreign-thread' }),
      ).rejects.toThrow('LIVE_RUNTIME_UNAVAILABLE');
    } finally {
      runtime.stopAll();
    }
  });
  it('refuses a resource with no native process provenance', async () => {
    const { runtime, launch } = fixture(false);
    const owning = await runtime.start(session(), 'time');
    try {
      await expect(runtime.inspectLiveAdmission(owning)).rejects.toThrow(
        'LIVE_RUNTIME_UNAVAILABLE',
      );
      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      runtime.stopAll();
    }
  });
  it('fences a lost owning resource while configuration inspection is outstanding', async () => {
    const { runtime, setConfiguration } = fixture();
    const owning = await runtime.start(session(), 'time');
    let release: (value: unknown) => void = () => {};
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    setConfiguration(
      () =>
        new Promise((resolve) => {
          release = resolve;
          entered();
        }),
    );
    const pending = runtime.inspectLiveAdmission(owning);
    const rejected = expect(pending).rejects.toThrow('LIVE_RUNTIME_UNAVAILABLE');
    await reading;
    runtime.stopAll();
    release({ config: {}, layers: [] });
    await rejected;
  });
  it('awaits a cold owning catalog beyond five seconds and reads current sources afterwards', async () => {
    const f = fixture();
    const owning = await f.runtime.start(session(), 'time');
    let release!: (value: unknown) => void;
    f.setMcp(async (params) => {
      const name = (params as { serverName: string }).serverName;
      if (name === 'context-mode') return new Promise((resolve) => (release = resolve));
      return { data: [{ name, runtimeStatus: 'connected', tools: {} }], nextCursor: null };
    });
    vi.useFakeTimers();
    try {
      let complete = false;
      const observed = f.runtime.inspectLiveAdmission(owning).then((value) => {
        complete = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(33_654);
      expect(complete).toBe(false);
      f.setConfiguration(async () => ({ config: { current: true }, layers: [] }));
      release({
        data: [{ name: 'context-mode', runtimeStatus: 'connected', tools: { actual: {} } }],
        nextCursor: null,
      });
      const result = await observed;
      expect(result.configuration).toEqual({ config: { current: true }, layers: [] });
      expect(result.mcp).toMatchObject({ data: [{ tools: { actual: {} } }, {}] });
      expect(f.launch).toHaveBeenCalledTimes(1);
      expect(f.calls.some((call) => call.method === 'turn/start')).toBe(false);
    } finally {
      f.runtime.stopAll();
      vi.useRealTimers();
    }
  });
  it('observes terminal owning statuses instead of accepting an asynchronously starting proxy', async () => {
    const f = fixture();
    const owning = await f.runtime.start(session(), 'time');
    let attempts = 0;
    f.setMcp(async (params) => {
      const name = (params as { serverName: string }).serverName;
      return {
        data: [
          {
            name,
            runtimeStatus: name === 'context-mode' && attempts++ === 0 ? 'starting' : 'failed',
            tools: {},
          },
        ],
        nextCursor: null,
      };
    });
    try {
      const result = await f.runtime.inspectLiveAdmission(owning);
      expect(result.mcp).toMatchObject({
        data: [{ runtimeStatus: 'failed' }, { runtimeStatus: 'failed' }],
      });
      const queries = f.calls.filter((call) => call.method === 'mcpServerStatus/list');
      expect(queries).toHaveLength(3);
      expect(
        queries.every((call) => (call.params as { threadId: string }).threadId === owning.threadId),
      ).toBe(true);
      expect(queries.every((call) => (call.params as { serverName?: string }).serverName)).toBe(
        true,
      );
    } finally {
      f.runtime.stopAll();
    }
  });
  it('bounds a stalled owning catalog without launching a replacement or observing stale sources', async () => {
    const f = fixture();
    const owning = await f.runtime.start(session(), 'time');
    f.setMcp(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const before = f.calls.length;
      const rejected = expect(f.runtime.inspectLiveAdmission(owning)).rejects.toThrow(
        'LIVE_RUNTIME_UNAVAILABLE',
      );
      await vi.advanceTimersByTimeAsync(125_000);
      await rejected;
      expect(f.calls.slice(before).map((call) => call.method)).toEqual(['mcpServerStatus/list']);
      expect(f.launch).toHaveBeenCalledTimes(1);
    } finally {
      f.runtime.stopAll();
      vi.useRealTimers();
    }
  });
  it('cancels pending owning catalog discovery on stop and fences a late reply', async () => {
    const f = fixture();
    const owning = await f.runtime.start(session(), 'time');
    let release!: (value: unknown) => void;
    f.setMcp(() => new Promise((resolve) => (release = resolve)));
    const before = f.calls.length;
    const rejected = expect(f.runtime.inspectLiveAdmission(owning)).rejects.toThrow(
      'LIVE_RUNTIME_UNAVAILABLE',
    );
    f.runtime.stop(owning.id);
    await rejected;
    release({ data: [], nextCursor: null });
    await Promise.resolve();
    expect(f.calls.slice(before).map((call) => call.method)).toEqual(['mcpServerStatus/list']);
    expect(f.runtime.liveOwnerIds()).toEqual([]);
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
});
